import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/Database';
import { AuthService } from './AuthService';
import { _resetJwtSecretForTesting } from './jwtSecret';

beforeEach(() => {
  _resetJwtSecretForTesting();
  process.env.JWT_SECRET = 'test-secret-test-secret-1234567890';
});

function makeService() {
  const db = openDatabase({ inMemory: true });
  return new AuthService(db);
}

describe('AuthService.signup', () => {
  it('creates a user and returns a session token', () => {
    const auth = makeService();
    const result = auth.signup({
      playerName: 'たろう',
      userId: 'puyo-001',
      password: 'p4ssw0rd!',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session.user.userId).toBe('puyo-001');
    expect(result.session.user.playerName).toBe('たろう');
    expect(typeof result.session.token).toBe('string');
    expect(result.session.token.length).toBeGreaterThan(20);
  });

  it('rejects a duplicate userId', () => {
    const auth = makeService();
    auth.signup({
      playerName: 'A',
      userId: 'dup',
      password: 'p4ssw0rd!',
    });
    const second = auth.signup({
      playerName: 'B',
      userId: 'dup',
      password: 'p4ssw0rd!',
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe('USER_ID_TAKEN');
  });

  it('rejects a malformed body', () => {
    const auth = makeService();
    const result = auth.signup({ userId: 'no_name' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('INVALID_BODY');
  });
});

describe('AuthService.login', () => {
  it('returns INVALID_CREDENTIALS for unknown user', () => {
    const auth = makeService();
    const result = auth.login({ userId: 'nope', password: 'p4ssw0rd!' });
    if (result.ok) return;
    expect(result.code).toBe('INVALID_CREDENTIALS');
  });

  it('returns INVALID_CREDENTIALS on wrong password', () => {
    const auth = makeService();
    auth.signup({
      playerName: 'A',
      userId: 'alice',
      password: 'correct1!',
    });
    const result = auth.login({ userId: 'alice', password: 'wrong___' });
    if (result.ok) return;
    expect(result.code).toBe('INVALID_CREDENTIALS');
  });

  it('accepts valid credentials', () => {
    const auth = makeService();
    auth.signup({
      playerName: 'Alice',
      userId: 'alice',
      password: 'correct1!',
    });
    const result = auth.login({ userId: 'alice', password: 'correct1!' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session.user.userId).toBe('alice');
  });
});

describe('AuthService.verify', () => {
  it('returns null for missing or malformed tokens', () => {
    const auth = makeService();
    expect(auth.verify(undefined)).toBeNull();
    expect(auth.verify('garbage')).toBeNull();
  });

  it('round-trips a freshly-issued token', () => {
    const auth = makeService();
    const signup = auth.signup({
      playerName: 'Bob',
      userId: 'bob',
      password: 'p4ssw0rd!',
    });
    if (!signup.ok) throw new Error('signup failed');
    const verified = auth.verify(signup.session.token);
    expect(verified).not.toBeNull();
    expect(verified?.user.userId).toBe('bob');
  });
});

describe('AuthService.createExternalUser', () => {
  it('creates an account that cannot be logged into with a password', () => {
    const auth = makeService();
    const dbUserId = auth.createExternalUser({ userId: 'tm42', playerName: 'テクマナ太郎' });
    expect(dbUserId).toBeGreaterThan(0);

    const session = auth.mintSessionFor(dbUserId);
    expect(session?.user.userId).toBe('tm42');
    expect(session?.user.playerName).toBe('テクマナ太郎');

    // No password was ever chosen, so nothing a caller can supply should
    // authenticate — including the empty string.
    for (const password of ['', 'password', 'tm42']) {
      expect(auth.login({ userId: 'tm42', password }).ok).toBe(false);
    }
  });

  it('sidesteps a userId that is already taken', () => {
    const auth = makeService();
    auth.signup({ playerName: '先客', userId: 'tm42', password: 'p4ssw0rd!' });

    const dbUserId = auth.createExternalUser({ userId: 'tm42', playerName: 'あとから' });
    const session = auth.mintSessionFor(dbUserId);
    expect(session?.user.userId).toBe('tm42_2');
    // The original account is untouched and still logs in.
    expect(auth.login({ userId: 'tm42', password: 'p4ssw0rd!' }).ok).toBe(true);
  });

  it('falls back to a display name when the provider gives none', () => {
    const auth = makeService();
    const dbUserId = auth.createExternalUser({ userId: 'tm7', playerName: '   ' });
    expect(auth.mintSessionFor(dbUserId)?.user.playerName).toBe('プレイヤー');
  });

  it('mintSessionFor returns null for an unknown id', () => {
    const auth = makeService();
    expect(auth.mintSessionFor(99999)).toBeNull();
  });
});
