import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/Database';
import { AuthService } from './AuthService';
import { PasswordResetService } from './PasswordResetService';
import { _resetJwtSecretForTesting } from './jwtSecret';

beforeEach(() => {
  _resetJwtSecretForTesting();
  process.env.JWT_SECRET = 'test-secret-test-secret-1234567890';
});

interface Harness {
  db: Database;
  auth: AuthService;
  resets: PasswordResetService;
}

function makeHarness(): Harness {
  const db = openDatabase({ inMemory: true });
  const auth = new AuthService(db);
  const resets = new PasswordResetService(db);
  return { db, auth, resets };
}

function seedUser(
  auth: AuthService,
  overrides: Partial<{
    playerName: string;
    userId: string;
    password: string;
    email: string;
  }> = {},
): void {
  const result = auth.signup({
    playerName: 'たろう',
    userId: 'puyo-001',
    password: 'p4ssw0rd!',
    email: 'a@b.co',
    ...overrides,
  });
  if (!result.ok) throw new Error(`seed signup failed: ${result.code}`);
}

describe('PasswordResetService.request', () => {
  it('returns null for an unknown email (no enumeration)', () => {
    const { resets } = makeHarness();
    expect(resets.request('nobody@example.com')).toBeNull();
  });

  it('mints a plaintext token for a known email and persists a hashed row', () => {
    const { db, auth, resets } = makeHarness();
    seedUser(auth);
    const minted = resets.request('a@b.co');
    expect(minted).not.toBeNull();
    if (!minted) return;
    expect(minted.userId).toBe('puyo-001');
    expect(minted.playerName).toBe('たろう');
    expect(typeof minted.token).toBe('string');
    expect(minted.token.length).toBeGreaterThan(20);

    const rows = db.prepare('SELECT token_hash, used_at FROM password_resets').all() as Array<{
      token_hash: string;
      used_at: string | null;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).not.toBe(minted.token); // hashed, not plaintext
    expect(rows[0]?.used_at).toBeNull();
  });
});

describe('PasswordResetService.confirm', () => {
  it('rejects malformed passwords with INVALID_PASSWORD', () => {
    const { auth, resets } = makeHarness();
    seedUser(auth);
    const minted = resets.request('a@b.co');
    if (!minted) throw new Error('mint failed');
    const result = resets.confirm(minted.token, 'short');
    expect('error' in result && result.error).toBe('INVALID_PASSWORD');
  });

  it('rejects unknown tokens with INVALID_TOKEN', () => {
    const { auth, resets } = makeHarness();
    seedUser(auth);
    resets.request('a@b.co');
    const result = resets.confirm('not-a-real-token-1234567890', 'newp4ss!');
    expect('error' in result && result.error).toBe('INVALID_TOKEN');
  });

  it('rotates the password on success and allows login with the new one', () => {
    const { auth, resets } = makeHarness();
    seedUser(auth);
    const minted = resets.request('a@b.co');
    if (!minted) throw new Error('mint failed');
    const result = resets.confirm(minted.token, 'newp4ss!');
    expect('userId' in result && result.userId).toBe('puyo-001');

    // Old password no longer works.
    const oldLogin = auth.login({ userId: 'puyo-001', password: 'p4ssw0rd!' });
    expect(oldLogin.ok).toBe(false);

    // New password works.
    const newLogin = auth.login({ userId: 'puyo-001', password: 'newp4ss!' });
    expect(newLogin.ok).toBe(true);
  });

  it('refuses to reuse a consumed token', () => {
    const { auth, resets } = makeHarness();
    seedUser(auth);
    const minted = resets.request('a@b.co');
    if (!minted) throw new Error('mint failed');
    const first = resets.confirm(minted.token, 'newp4ss!');
    expect('userId' in first).toBe(true);
    const second = resets.confirm(minted.token, 'anotherp4!');
    expect('error' in second && second.error).toBe('INVALID_TOKEN');
  });

  it('rejects an expired token', () => {
    const { db, auth, resets } = makeHarness();
    seedUser(auth);
    const minted = resets.request('a@b.co');
    if (!minted) throw new Error('mint failed');
    // Backdate expires_at to the past.
    db.prepare('UPDATE password_resets SET expires_at = ?').run(
      new Date(Date.now() - 60_000).toISOString(),
    );
    const result = resets.confirm(minted.token, 'newp4ss!');
    expect('error' in result && result.error).toBe('INVALID_TOKEN');
  });

  it('does not match a token minted for a different user', () => {
    const { auth, resets } = makeHarness();
    seedUser(auth, { userId: 'alice', email: 'alice@b.co' });
    seedUser(auth, { userId: 'bob', email: 'bob@b.co' });
    const aliceMint = resets.request('alice@b.co');
    if (!aliceMint) throw new Error('mint failed');
    // Bob requests a reset too; confirming with alice's token should still
    // resolve to alice (single-token semantics, not pool-shared).
    resets.request('bob@b.co');
    const result = resets.confirm(aliceMint.token, 'newp4ss!');
    expect('userId' in result && result.userId).toBe('alice');
  });
});
