/**
 * TechmanaService — Techmana (テクマナ) SSO と、そこに置くセーブデータ。
 *
 * ChainDrop はテクマナの「機密クライアント」として振る舞う。つまり
 * 認可コードとアクセストークンのやり取りは全てこのサーバ側で完結し、
 * ブラウザにはテクマナのトークンを一切渡さない。ブラウザが持つのは
 * これまで通り ChainDrop 自身の HttpOnly セッション Cookie だけ。
 *
 * これにより
 *  - GitHub Pages 側に OAuth コールバック用のパスを作らずに済む
 *    (SPA に router が無く、Pages は deep link で 404 になるため)
 *  - テクマナのトークンが XSS で盗まれる経路が存在しない
 *  - テクマナ側の CORS 設定に依存しない(サーバ間通信のため)
 */

import { createHash, randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { config } from '../config';

/** 認可フロー中だけ有効な一時状態。Cookie に入れて持ち回る。 */
export interface PendingAuth {
  state: string;
  verifier: string;
  /** 既存アカウントに紐付ける場合の ChainDrop ユーザーID。新規ログインなら null。 */
  linkUserId: number | null;
}

export interface TechmanaProfile {
  userId: number;
  nickname: string;
  name: string;
}

export interface LinkRow {
  id: number;
  user_id: number;
  provider: string;
  subject: string;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: string | null;
  scope: string | null;
}

const PROVIDER = 'techmana';
/** テクマナ側の上限は 1MB。手前で弾いて無駄な往復を避ける。 */
const MAX_SAVE_BYTES = 1_000_000;
/** 期限判定の余裕。ネットワーク遅延で切れかけを掴まないように。 */
const EXPIRY_SKEW_MS = 30_000;

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export class TechmanaService {
  constructor(private readonly db: Database) {}

  /* ----------------------------- 認可フロー ----------------------------- */

  /** state と PKCE verifier を作り、テクマナの認可画面URLを組み立てる。 */
  beginAuth(linkUserId: number | null): { url: string; pending: PendingAuth } {
    const state = base64url(randomBytes(24));
    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash('sha256').update(verifier).digest());

    const q = new URLSearchParams({
      client_id: config.techmana.clientId,
      redirect_uri: config.techmana.redirectUri,
      response_type: 'code',
      scope: 'profile save',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    return {
      url: `${config.techmana.baseUrl}/oauth/authorize?${q.toString()}`,
      pending: { state, verifier, linkUserId },
    };
  }

  /** 認可コードをトークンに交換する。 */
  async exchangeCode(code: string, verifier: string): Promise<TokenSet> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: config.techmana.clientId,
      client_secret: config.techmana.clientSecret,
      code,
      redirect_uri: config.techmana.redirectUri,
      code_verifier: verifier,
    });
    return this.postToken(body);
  }

  /** アクセストークンからテクマナ側のプロフィールを引く。 */
  async fetchProfile(accessToken: string): Promise<TechmanaProfile> {
    const res = await fetch(`${config.techmana.baseUrl}/api/v1/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`techmana /me failed: ${res.status}`);
    const d = (await res.json()) as { user_id?: number; nickname?: string; name?: string };
    if (typeof d.user_id !== 'number') throw new Error('techmana /me returned no user_id');
    return {
      userId: d.user_id,
      nickname: (d.nickname ?? '').trim(),
      name: (d.name ?? '').trim(),
    };
  }

  /* ------------------------------- 紐付け ------------------------------- */

  findLinkBySubject(subject: string): LinkRow | undefined {
    return this.db
      .prepare('SELECT * FROM oauth_links WHERE provider = ? AND subject = ?')
      .get(PROVIDER, subject) as LinkRow | undefined;
  }

  findLinkByUser(userId: number): LinkRow | undefined {
    return this.db
      .prepare('SELECT * FROM oauth_links WHERE provider = ? AND user_id = ?')
      .get(PROVIDER, userId) as LinkRow | undefined;
  }

  /** 紐付けを作る/更新する。トークンはここにだけ置く。 */
  saveLink(userId: number, subject: string, tokens: TokenSet): void {
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + tokens.expiresIn * 1000).toISOString();
    this.db
      .prepare(
        `INSERT INTO oauth_links
           (user_id, provider, subject, access_token, refresh_token, expires_at, scope, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (provider, subject) DO UPDATE SET
           user_id = excluded.user_id,
           access_token = excluded.access_token,
           refresh_token = excluded.refresh_token,
           expires_at = excluded.expires_at,
           scope = excluded.scope,
           updated_at = excluded.updated_at`,
      )
      .run(
        userId,
        PROVIDER,
        subject,
        tokens.accessToken,
        tokens.refreshToken,
        expiresAt,
        tokens.scope,
        now,
        now,
      );
  }

  /** 連携解除。ChainDrop 側のアカウントとセーブは残す。 */
  unlink(userId: number): void {
    this.db
      .prepare('DELETE FROM oauth_links WHERE provider = ? AND user_id = ?')
      .run(PROVIDER, userId);
  }

  /* --------------------------- セーブデータ --------------------------- */

  /**
   * テクマナのセーブAPIを叩く。期限切れなら自動でリフレッシュする。
   * 呼び出し側にトークンを見せないため、この層で完結させる。
   */
  async readSave(userId: number, slot: string): Promise<unknown | null> {
    const token = await this.usableToken(userId);
    // Distinct from the `null` below: "not linked" and "linked but no
    // save yet" lead the caller down different paths.
    if (!token) throw new TechmanaApiError(401, 'not linked');
    const res = await fetch(`${config.techmana.baseUrl}/api/v1/saves/${encodeURIComponent(slot)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new TechmanaApiError(res.status, `read save failed: ${res.status}`);
    return res.json();
  }

  /**
   * @returns 成功時はテクマナの応答、競合(409)時は `conflict` を立てて
   *          サーバ側の現状を返す。呼び出し側がユーザーに選ばせる。
   */
  async writeSave(
    userId: number,
    slot: string,
    payload: unknown,
    saveSeq?: number,
  ): Promise<{ ok: true; body: unknown } | { ok: false; conflict: boolean; body: unknown }> {
    const token = await this.usableToken(userId);
    if (!token) throw new TechmanaApiError(401, 'not linked');

    const serialized = JSON.stringify({ payload, ...(saveSeq ? { save_seq: saveSeq } : {}) });
    if (Buffer.byteLength(serialized, 'utf8') > MAX_SAVE_BYTES) {
      throw new TechmanaApiError(413, 'save payload too large');
    }
    const res = await fetch(`${config.techmana.baseUrl}/api/v1/saves/${encodeURIComponent(slot)}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: serialized,
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, body };
    if (res.status === 409) return { ok: false, conflict: true, body };
    throw new TechmanaApiError(res.status, `write save failed: ${res.status}`);
  }

  /* ------------------------------- private ------------------------------ */

  /** 有効なアクセストークンを返す。期限切れならリフレッシュを試みる。 */
  private async usableToken(userId: number): Promise<string | null> {
    const link = this.findLinkByUser(userId);
    if (!link?.access_token) return null;

    const expiresAt = link.expires_at ? Date.parse(link.expires_at) : 0;
    if (expiresAt - EXPIRY_SKEW_MS > Date.now()) return link.access_token;
    if (!link.refresh_token) return null;

    try {
      const tokens = await this.postToken(
        new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: config.techmana.clientId,
          client_secret: config.techmana.clientSecret,
          refresh_token: link.refresh_token,
        }),
      );
      this.saveLink(link.user_id, link.subject, tokens);
      return tokens.accessToken;
    } catch {
      // リフレッシュ失敗 = テクマナ側で連携が切られた等。紐付けを落として
      // 「未連携」状態に戻す(ゲーム自体は遊べる)。
      this.unlink(userId);
      return null;
    }
  }

  private async postToken(body: URLSearchParams): Promise<TokenSet> {
    const res = await fetch(`${config.techmana.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new TechmanaApiError(
        res.status,
        `token endpoint ${res.status}: ${detail.slice(0, 200)}`,
      );
    }
    const d = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };
    if (!d.access_token) throw new TechmanaApiError(502, 'token response had no access_token');
    return {
      accessToken: d.access_token,
      refreshToken: d.refresh_token ?? null,
      expiresIn: typeof d.expires_in === 'number' ? d.expires_in : 3600,
      scope: d.scope ?? '',
    };
  }
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
  scope: string;
}

export class TechmanaApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'TechmanaApiError';
  }
}
