/**
 * TechmanaService — the paths that only show up against a live
 * provider: expired tokens, a revoked link, and a lost write race.
 * `fetch` is stubbed so none of this touches the network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/Database';
import { AuthService } from './AuthService';
import { TechmanaApiError, TechmanaService, type TokenSet } from './TechmanaService';
import { _resetJwtSecretForTesting } from './jwtSecret';

const SLOT = 'chaindrop';

function tokens(over: Partial<TokenSet> = {}): TokenSet {
  return {
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    expiresIn: 3600,
    scope: 'profile save',
    ...over,
  };
}

/** A `fetch` stub that answers from a queue of [status, body] pairs. */
function stubFetch(responses: Array<[number, unknown]>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  let i = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      const [status, body] = responses[Math.min(i, responses.length - 1)] ?? [500, {}];
      i += 1;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as unknown as Response;
    }),
  );
  return calls;
}

function setup() {
  const db = openDatabase({ inMemory: true });
  const auth = new AuthService(db);
  const techmana = new TechmanaService(db);
  const userId = auth.createExternalUser({ userId: 'tm1', playerName: 'テスト' });
  return { db, auth, techmana, userId };
}

beforeEach(() => {
  _resetJwtSecretForTesting();
  process.env.JWT_SECRET = 'test-secret-test-secret-1234567890';
  process.env.TECHMANA_CLIENT_ID = 'cid';
  process.env.TECHMANA_CLIENT_SECRET = 'csec';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('beginAuth', () => {
  it('produces a distinct state and verifier each time', () => {
    const { techmana } = setup();
    const a = techmana.beginAuth(null);
    const b = techmana.beginAuth(null);
    expect(a.pending.state).not.toBe(b.pending.state);
    expect(a.pending.verifier).not.toBe(b.pending.verifier);
    // The verifier stays on the server; only its hash goes in the URL.
    expect(a.url).not.toContain(a.pending.verifier);
    expect(a.url).toContain('code_challenge_method=S256');
  });

  it('carries the account to link through the round-trip', () => {
    const { techmana, userId } = setup();
    expect(techmana.beginAuth(userId).pending.linkUserId).toBe(userId);
  });
});

describe('saveLink', () => {
  it('re-points an existing link at whoever authenticated last', () => {
    const { techmana, auth, userId } = setup();
    techmana.saveLink(userId, 'sub-1', tokens());
    expect(techmana.findLinkBySubject('sub-1')?.user_id).toBe(userId);

    const other = auth.createExternalUser({ userId: 'tm2', playerName: 'べつの人' });
    techmana.saveLink(other, 'sub-1', tokens({ accessToken: 'at-2' }));

    // One row, now owned by the second account — not a duplicate.
    expect(techmana.findLinkBySubject('sub-1')?.user_id).toBe(other);
    expect(techmana.findLinkByUser(userId)).toBeUndefined();
  });
});

describe('readSave', () => {
  it('refuses when the account has no link at all', async () => {
    const { techmana, userId } = setup();
    stubFetch([[200, {}]]);
    await expect(techmana.readSave(userId, SLOT)).rejects.toBeInstanceOf(TechmanaApiError);
  });

  it('returns null for a linked account with nothing stored yet', async () => {
    const { techmana, userId } = setup();
    techmana.saveLink(userId, 'sub-1', tokens());
    stubFetch([[404, { error: 'not_found' }]]);
    await expect(techmana.readSave(userId, SLOT)).resolves.toBeNull();
  });

  it('refreshes an expired access token before calling the API', async () => {
    const { techmana, userId } = setup();
    techmana.saveLink(userId, 'sub-1', tokens({ expiresIn: -60 }));

    const calls = stubFetch([
      [200, { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600, scope: 'save' }],
      [200, { slot: SLOT, payload: { hello: 'world' }, save_seq: 3 }],
    ]);

    await expect(techmana.readSave(userId, SLOT)).resolves.toEqual({
      slot: SLOT,
      payload: { hello: 'world' },
      save_seq: 3,
    });

    expect(calls[0]?.url).toContain('/oauth/token');
    expect(calls[1]?.init?.headers).toMatchObject({ Authorization: 'Bearer at-2' });
    // The rotated pair is persisted, so the next call skips the refresh.
    expect(techmana.findLinkByUser(userId)?.refresh_token).toBe('rt-2');
  });

  it('drops the link when the refresh is rejected', async () => {
    const { techmana, userId } = setup();
    techmana.saveLink(userId, 'sub-1', tokens({ expiresIn: -60 }));
    stubFetch([[400, { error: 'invalid_grant' }]]);

    await expect(techmana.readSave(userId, SLOT)).rejects.toBeInstanceOf(TechmanaApiError);
    // Back to "not linked" rather than stuck retrying a dead token.
    expect(techmana.findLinkByUser(userId)).toBeUndefined();
  });
});

describe('writeSave', () => {
  it('reports a lost race instead of throwing', async () => {
    const { techmana, userId } = setup();
    techmana.saveLink(userId, 'sub-1', tokens());
    stubFetch([[409, { error: 'stale_save', current: { save_seq: 9 } }]]);

    const res = await techmana.writeSave(userId, SLOT, { a: 1 }, 2);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.conflict).toBe(true);
    expect(res.body).toMatchObject({ current: { save_seq: 9 } });
  });

  it('rejects an oversized payload without calling the API', async () => {
    const { techmana, userId } = setup();
    techmana.saveLink(userId, 'sub-1', tokens());
    const calls = stubFetch([[200, { ok: true }]]);

    const huge = { blob: 'x'.repeat(1_100_000) };
    await expect(techmana.writeSave(userId, SLOT, huge, 2)).rejects.toMatchObject({ status: 413 });
    expect(calls).toHaveLength(0);
  });

  it('sends the sequence number the caller asked for', async () => {
    const { techmana, userId } = setup();
    techmana.saveLink(userId, 'sub-1', tokens());
    const calls = stubFetch([[200, { ok: true, save_seq: 5 }]]);

    await techmana.writeSave(userId, SLOT, { a: 1 }, 5);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ payload: { a: 1 }, save_seq: 5 });
  });
});

describe('unlink', () => {
  it('removes the link but leaves the account alone', () => {
    const { techmana, auth, userId } = setup();
    techmana.saveLink(userId, 'sub-1', tokens());
    techmana.unlink(userId);
    expect(techmana.findLinkByUser(userId)).toBeUndefined();
    expect(auth.mintSessionFor(userId)?.user.userId).toBe('tm1');
  });
});
