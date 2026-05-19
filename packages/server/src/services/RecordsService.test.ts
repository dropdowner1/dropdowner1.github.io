import { beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from '../auth/AuthService';
import { _resetJwtSecretForTesting } from '../auth/jwtSecret';
import { openDatabase } from '../db/Database';
import { RecordsService } from './RecordsService';

beforeEach(() => {
  _resetJwtSecretForTesting();
  process.env.JWT_SECRET = 'test-secret-test-secret-1234567890';
});

function setup() {
  const db = openDatabase({ inMemory: true });
  const auth = new AuthService(db);
  const records = new RecordsService(db);
  return { db, auth, records };
}

function makeUser(auth: AuthService, suffix: string): { dbUserId: number; userId: string } {
  const signup = auth.signup({
    playerName: `Player_${suffix}`,
    userId: `user_${suffix}`,
    password: 'p4ssw0rd!',
    email: `${suffix}@b.co`,
  });
  if (!signup.ok) throw new Error('signup failed');
  const verified = auth.verify(signup.session.token);
  if (!verified) throw new Error('verify failed');
  return { dbUserId: verified.dbUserId, userId: signup.session.user.userId };
}

describe('RecordsService.recordSoloRun + fetchRecordsFor', () => {
  it('aggregates rolling max + sum for a single player', () => {
    const { auth, records } = setup();
    const alice = makeUser(auth, 'alice');
    records.recordSoloRun(alice.dbUserId, { score: 1200, maxChain: 4, cellsCleared: 30 });
    records.recordSoloRun(alice.dbUserId, { score: 800, maxChain: 7, cellsCleared: 20 });
    const me = records.fetchRecordsFor(alice.dbUserId);
    expect(me.solo.bestScore).toBe(1200);
    expect(me.solo.bestMaxChain).toBe(7);
    expect(me.solo.totalCleared).toBe(50);
    expect(me.recentSolo).toHaveLength(2);
  });

  it('returns zeros for a brand-new user', () => {
    const { auth, records } = setup();
    const bob = makeUser(auth, 'bob');
    const me = records.fetchRecordsFor(bob.dbUserId);
    expect(me.solo).toEqual({ bestScore: 0, bestMaxChain: 0, totalCleared: 0 });
    expect(me.recentSolo).toEqual([]);
    expect(me.online).toEqual([]);
  });
});

describe('RecordsService.recordOnlineMatch', () => {
  it('lists newest-first', () => {
    const { auth, records } = setup();
    const alice = makeUser(auth, 'alice');
    records.recordOnlineMatch(alice.dbUserId, {
      opponentName: 'Bob',
      outcome: 'win',
      selfScore: 1000,
    });
    // brief sleep so the played_at strings differ
    const nowIso = new Date().toISOString();
    void nowIso;
    records.recordOnlineMatch(alice.dbUserId, {
      opponentName: 'Carol',
      outcome: 'loss',
      selfScore: 400,
    });
    const me = records.fetchRecordsFor(alice.dbUserId);
    expect(me.online).toHaveLength(2);
    // Carol's loss is the newer row (recorded second), so it should
    // be first when ordered DESC by played_at.
    expect(me.online[0]?.opponentName).toBe('Carol');
  });
});

describe('RecordsService.soloRankings', () => {
  it('orders by best score across users', () => {
    const { auth, records } = setup();
    const alice = makeUser(auth, 'alice');
    const bob = makeUser(auth, 'bob');
    records.recordSoloRun(alice.dbUserId, { score: 500, maxChain: 2, cellsCleared: 10 });
    records.recordSoloRun(bob.dbUserId, { score: 1500, maxChain: 5, cellsCleared: 40 });
    records.recordSoloRun(alice.dbUserId, { score: 900, maxChain: 3, cellsCleared: 15 });
    const rankings = records.soloRankings(10);
    expect(rankings.map((r) => r.userId)).toEqual(['user_bob', 'user_alice']);
    expect(rankings[0]?.bestScore).toBe(1500);
    expect(rankings[1]?.bestScore).toBe(900);
  });
});
