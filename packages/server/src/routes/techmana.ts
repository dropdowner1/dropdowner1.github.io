import type { CookieOptions, Request, Response, Router } from 'express';
import express from 'express';
import type { AuthService } from '../auth/AuthService';
import { TechmanaApiError, type TechmanaService } from '../auth/TechmanaService';
import { config, techmanaEnabled } from '../config';
import { COOKIE_NAME, type ResolvedSession, requireAuth } from '../middleware/requireAuth';
import { logger } from '../util/logger';

/** 認可フロー中だけ生きる一時 Cookie。 */
const PENDING_COOKIE = 'chaindrop_oauth';
const PENDING_TTL_MS = 10 * 60 * 1000;
/** クラウドセーブのスロット名。ゲーム側で1枠しか使わない。 */
const SAVE_SLOT = 'chaindrop';

export function techmanaRouter(auth: AuthService, techmana: TechmanaService): Router {
  const router = express.Router();

  /**
   * 連携の入口。ブラウザをテクマナの同意画面へ送る。
   * 既にログイン中ならそのアカウントに紐付ける(併存方針)。
   */
  router.get('/start', (req, res) => {
    if (!techmanaEnabled()) {
      return res
        .status(503)
        .json({ error: 'TECHMANA_DISABLED', message: 'テクマナ連携は未設定です' });
    }
    const current = auth.verify(req.cookies?.[COOKIE_NAME]);
    const { url, pending } = techmana.beginAuth(current?.dbUserId ?? null);

    res.cookie(PENDING_COOKIE, JSON.stringify(pending), {
      ...pendingCookieOpts(),
      maxAge: PENDING_TTL_MS,
    });
    res.redirect(url);
  });

  /**
   * テクマナからの戻り先。コードをトークンに換え、ChainDrop の
   * アカウントに紐付けてセッションを張り、ゲーム画面へ返す。
   */
  router.get('/callback', async (req, res) => {
    if (!techmanaEnabled()) return backToClient(res, 'disabled');

    const pending = readPending(req);
    res.clearCookie(PENDING_COOKIE, pendingCookieOpts());
    if (!pending) return backToClient(res, 'expired');

    const error = typeof req.query.error === 'string' ? req.query.error : null;
    if (error) return backToClient(res, error === 'access_denied' ? 'denied' : 'error');

    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    // state 照合。攻撃者が用意したコードを踏ませる CSRF を防ぐ。
    if (!code || !timingSafeEqual(state, pending.state)) return backToClient(res, 'state');

    try {
      const tokens = await techmana.exchangeCode(code, pending.verifier);
      const profile = await techmana.fetchProfile(tokens.accessToken);
      const subject = String(profile.userId);

      const dbUserId = resolveUser(auth, techmana, subject, profile, pending.linkUserId);
      techmana.saveLink(dbUserId, subject, tokens);

      const session = auth.mintSessionFor(dbUserId);
      if (!session) return backToClient(res, 'error');
      res.cookie(COOKIE_NAME, session.token, {
        ...sessionCookieOpts(),
        maxAge: session.maxAge * 1000,
      });
      logger.info({ dbUserId, subject }, 'techmana sso linked');
      return backToClient(res, null);
    } catch (err) {
      logger.warn({ err }, 'techmana callback failed');
      return backToClient(res, 'error');
    }
  });

  /** 連携状態の確認。 */
  router.get('/status', requireAuth(auth), (_req: Request, res: Response) => {
    const s = res.locals.session as ResolvedSession;
    const link = techmana.findLinkByUser(s.dbUserId);
    res.json({ linked: Boolean(link), subject: link?.subject ?? null, enabled: techmanaEnabled() });
  });

  /** 連携解除。ChainDrop のアカウントとセーブはそのまま残る。 */
  router.post('/unlink', requireAuth(auth), (_req: Request, res: Response) => {
    const s = res.locals.session as ResolvedSession;
    techmana.unlink(s.dbUserId);
    res.status(204).end();
  });

  return router;
}

/** クラウドセーブ(テクマナ側に保管)。 */
export function syncRouter(auth: AuthService, techmana: TechmanaService): Router {
  const router = express.Router();

  router.get('/save', requireAuth(auth), async (_req: Request, res: Response) => {
    const s = res.locals.session as ResolvedSession;
    try {
      const body = await techmana.readSave(s.dbUserId, SAVE_SLOT);
      if (body === null) return res.status(404).json({ error: 'NO_SAVE' });
      res.json(body);
    } catch (err) {
      sendSyncError(res, err);
    }
  });

  router.put('/save', requireAuth(auth), async (req: Request, res: Response) => {
    const s = res.locals.session as ResolvedSession;
    const payload = (req.body as { payload?: unknown } | undefined)?.payload;
    if (payload === undefined) {
      return res.status(400).json({ error: 'PAYLOAD_REQUIRED', message: 'payload がありません' });
    }
    const seqRaw = (req.body as { saveSeq?: unknown }).saveSeq;
    const saveSeq = typeof seqRaw === 'number' && Number.isFinite(seqRaw) ? seqRaw : undefined;

    try {
      const result = await techmana.writeSave(s.dbUserId, SAVE_SLOT, payload, saveSeq);
      if (!result.ok) {
        // 別端末が先に進めていた。上書きせず現状を返す。
        // テクマナ側の body にも `error` があるので、後から自分の
        // コードを被せて上書きされないようにする。
        return res.status(409).json({ ...(result.body as object), error: 'CONFLICT' });
      }
      res.json(result.body);
    } catch (err) {
      sendSyncError(res, err);
    }
  });

  return router;
}

/* ------------------------------- helpers ------------------------------- */

/**
 * 「誰としてログインさせるか」を決める。
 *  1. 既にこのテクマナIDと紐付いたアカウントがある → それ
 *  2. ChainDrop にログイン中 → そのアカウントに紐付ける(併存)
 *  3. どちらでもない → 新しいアカウントを作る
 */
function resolveUser(
  auth: AuthService,
  techmana: TechmanaService,
  subject: string,
  profile: { nickname: string; name: string },
  linkUserId: number | null,
): number {
  const existing = techmana.findLinkBySubject(subject);
  if (existing) return existing.user_id;
  if (linkUserId !== null) return linkUserId;

  const display = profile.nickname || profile.name || 'プレイヤー';
  return auth.createExternalUser({
    userId: `tm${subject}`,
    playerName: display.slice(0, 20),
  });
}

function readPending(
  req: Request,
): { state: string; verifier: string; linkUserId: number | null } | null {
  const raw = req.cookies?.[PENDING_COOKIE];
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    const d = JSON.parse(raw) as Record<string, unknown>;
    if (typeof d.state !== 'string' || typeof d.verifier !== 'string') return null;
    return {
      state: d.state,
      verifier: d.verifier,
      linkUserId: typeof d.linkUserId === 'number' ? d.linkUserId : null,
    };
  } catch {
    return null;
  }
}

/** 長さ差でも早期 return しない比較。 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function sendSyncError(res: Response, err: unknown): void {
  if (err instanceof TechmanaApiError) {
    if (err.status === 401) {
      // Deliberately NOT 409 — that status means "you lost a write race"
      // here, and the client acts on the two cases very differently.
      return void res
        .status(428)
        .json({ error: 'NOT_LINKED', message: 'テクマナ連携が切れています' });
    }
    if (err.status === 413) {
      return void res
        .status(413)
        .json({ error: 'TOO_LARGE', message: 'セーブデータが大きすぎます' });
    }
  }
  logger.warn({ err }, 'techmana sync failed');
  res.status(502).json({ error: 'SYNC_FAILED', message: 'テクマナと通信できませんでした' });
}

/**
 * ブラウザをゲーム画面へ返す。結果はクエリで伝え、SPA 側が読んだあと
 * URL から消す(router が無いのでハッシュではなくクエリを使う)。
 */
function backToClient(res: Response, error: string | null): void {
  const base = config.clientBaseUrl || 'https://dropdowner1.github.io/';
  const url = new URL(base);
  url.searchParams.set('techmana', error ? 'error' : 'ok');
  if (error) url.searchParams.set('reason', error);
  res.redirect(url.toString());
}

function isDev(): boolean {
  return process.env.NODE_ENV !== 'production';
}

/**
 * 認可フロー用の一時 Cookie。テクマナからのリダイレクトで戻ってくる
 * ときにも送られる必要があるため、本番では SameSite=None が要る
 * (トップレベル遷移なので Lax でも送られるが、Secure と揃えて明示する)。
 */
function pendingCookieOpts(): CookieOptions {
  return {
    httpOnly: true,
    path: '/',
    sameSite: isDev() ? 'lax' : 'none',
    secure: !isDev(),
    domain: config.cookieDomain,
  };
}

function sessionCookieOpts(): CookieOptions {
  return {
    httpOnly: true,
    path: '/',
    sameSite: isDev() ? 'lax' : 'none',
    secure: !isDev(),
    domain: config.cookieDomain,
  };
}
