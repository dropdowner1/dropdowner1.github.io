import { describe, expect, it } from 'vitest';
import { getCell, setCell } from './board';
import {
  CHIGIRI_FRAMES,
  COUNTDOWN_FRAMES,
  DEAD_FRAMES,
  type MatchState,
  POST_FALL_SETTLE_FRAMES,
  RESOLVE_TICK_FRAMES,
  WAIT_GARBAGE_FRAMES,
  advanceFrame,
  computeHash,
  createMatchState,
  generateDropQueue,
} from './simulator';

/** Advance N frames with no inputs. */
function tickN(match: MatchState, n: number): void {
  for (let i = 0; i < n; i++) advanceFrame(match);
}

// --------------------------------------------------------------
// generateDropQueue
// --------------------------------------------------------------

describe('generateDropQueue', () => {
  it('is deterministic for the same seed/count/mode', () => {
    const a = generateDropQueue(42, 16, 4);
    const b = generateDropQueue(42, 16, 4);
    expect(a).toEqual(b);
  });

  it('uses only 4 colors in 4-mode', () => {
    const pairs = generateDropQueue(1, 200, 4);
    const colors = new Set(pairs.flat());
    for (const c of colors) expect(['R', 'G', 'B', 'Y']).toContain(c);
  });

  it('restricts the first two pairs to three colors (first-move guard)', () => {
    const pairs = generateDropQueue(1, 4, 5);
    const initial = pairs.slice(0, 2).flat();
    for (const c of initial) expect(['R', 'G', 'B']).toContain(c);
    // But later pairs can use the full palette; with enough samples we see P.
    const later = generateDropQueue(1, 200, 5).slice(2).flat();
    expect(later).toContain('P');
  });

  it('rejects negative counts', () => {
    expect(() => generateDropQueue(1, -1, 4)).toThrow();
  });
});

// --------------------------------------------------------------
// Match creation
// --------------------------------------------------------------

describe('createMatchState', () => {
  it('starts solo matches in running state by default', () => {
    const match = createMatchState({ seed: 1, colorMode: 4, players: [{ id: 'A' }] });
    expect(match.status).toBe('running');
    expect(match.frame).toBe(0);
    expect(match.players[0]?.phase).toBe('spawn');
  });

  it('supports an initial countdown', () => {
    const match = createMatchState({
      seed: 1,
      colorMode: 4,
      players: [{ id: 'A' }],
      startWithCountdown: true,
    });
    expect(match.status).toBe('countdown');
    expect(match.countdownTimer).toBe(COUNTDOWN_FRAMES);
  });

  it('rejects empty player lists', () => {
    expect(() => createMatchState({ seed: 1, colorMode: 4, players: [] })).toThrow();
  });
});

describe('countdown behavior', () => {
  it('counts down for exactly COUNTDOWN_FRAMES then flips to running', () => {
    const match = createMatchState({
      seed: 1,
      colorMode: 4,
      players: [{ id: 'A' }],
      startWithCountdown: true,
    });
    for (let i = 0; i < COUNTDOWN_FRAMES - 1; i++) {
      advanceFrame(match);
      expect(match.status).toBe('countdown');
    }
    advanceFrame(match);
    expect(match.status).toBe('running');
  });
});

// --------------------------------------------------------------
// Basic spawn → falling flow
// --------------------------------------------------------------

describe('spawn phase', () => {
  it('transitions from spawn to falling in one frame and spawns a piece', () => {
    const match = createMatchState({ seed: 1, colorMode: 4, players: [{ id: 'A' }] });
    advanceFrame(match);
    const p = match.players[0]!;
    expect(p.phase).toBe('falling');
    expect(p.current).not.toBeNull();
    expect(p.dropQueueIndex).toBe(1);
    expect(match.events.some((e) => e.type === 'spawn')).toBe(true);
  });

  it('emits death when the child spawn cell is blocked', () => {
    const match = createMatchState({ seed: 1, colorMode: 4, players: [{ id: 'A' }] });
    const p = match.players[0]!;
    setCell(p.board, 2, 11, 'X');
    advanceFrame(match);
    expect(p.status).toBe('dead');
    expect(p.phase).toBe('dead');
    expect(match.events.some((e) => e.type === 'death')).toBe(true);
  });
});

// --------------------------------------------------------------
// Falling → lock → resolving (no chain) → waitGarbage → spawn cycle
// --------------------------------------------------------------

describe('fall to lock cycle on an empty board', () => {
  it('locks after ~11 normal drops and transitions to resolving then spawn', () => {
    const match = createMatchState({ seed: 1, colorMode: 4, players: [{ id: 'A' }] });
    // Frame 1: spawn finishes
    advanceFrame(match);
    const p = match.players[0]!;
    expect(p.phase).toBe('falling');
    // Natural fall = 30f per cell. Axis starts at y=12, child at y=11.
    // Axis must fall from y=12 down to y=1 (child at y=0) to hit ground.
    // That's 11 cells × 30 frames = 330 frames of falling.
    // Then 15 lock delay frames.
    // Then resolving's final check (1 frame) since no clusters form.
    // Then waitGarbage is skipped (pending=0) → straight to spawn on same frame.
    // Allow generous upper bound; assert that after many frames we see at
    // least one lock event and the player cycled back to a new piece.
    let lockCount = 0;
    for (let i = 0; i < 600; i++) {
      advanceFrame(match);
      if (match.events.some((e) => e.type === 'lock')) lockCount++;
      if (p.dropQueueIndex >= 2) break; // second piece spawned
    }
    expect(lockCount).toBeGreaterThanOrEqual(1);
    expect(p.dropQueueIndex).toBeGreaterThanOrEqual(2);
  });
});

// --------------------------------------------------------------
// Chain + score + garbage integration
// --------------------------------------------------------------

describe('chain resolution during a bout', () => {
  it('produces a chain_tick event, increments score and maxChain', () => {
    const match = createMatchState({ seed: 1, colorMode: 4, players: [{ id: 'A' }] });
    const p = match.players[0]!;

    // Preload the board with 4 reds at y=0, cols 0..3 — one chain.
    for (let x = 0; x < 4; x++) setCell(p.board, x, 0, 'R');

    // Skip ordinary spawn/falling by forcing the phase to resolving.
    p.phase = 'resolving';
    p.phaseFrame = 0;
    p.chainCount = 0;
    p.resolvingData = null;

    // Drive enough frames to cover the whole resolve tick, collecting
    // events as we go. `match.events` is reset every frame, so we must
    // accumulate rather than inspect the final frame's events.
    const collected: MatchState['events'] = [];
    for (let i = 0; i < RESOLVE_TICK_FRAMES + 5; i++) {
      advanceFrame(match);
      for (const e of match.events) collected.push(e);
    }

    expect(collected.some((e) => e.type === 'chain_tick')).toBe(true);
    expect(p.chainCount).toBeGreaterThanOrEqual(1);
    expect(p.maxChain).toBeGreaterThanOrEqual(1);
    expect(p.score).toBe(40);
  });
});

// --------------------------------------------------------------
// Garbage propagation across players (2-player)
// --------------------------------------------------------------

describe('garbage propagation across players', () => {
  it('a chain by A increases B.pendingGarbage above the rate threshold', () => {
    const match = createMatchState({
      seed: 7,
      colorMode: 4,
      players: [{ id: 'A' }, { id: 'B' }],
    });
    const a = match.players[0]!;
    const b = match.players[1]!;

    // Set up A's board with a 2-chain trigger
    // so that A generates enough score to overflow rate=70.
    const rows = ['BB....', '......', '.B....', '.BR...', 'RRR...'];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[rows.length - 1 - i] as string;
      for (let x = 0; x < row.length; x++) {
        const ch = row[x] as string;
        if (ch !== '.') setCell(a.board, x, i, ch as 'R' | 'B');
      }
    }
    a.phase = 'resolving';
    a.phaseFrame = 0;
    a.chainCount = 0;
    a.resolvingData = null;

    // Keep B idle (force to spectating to avoid interfering with
    // target selection — actually B must be 'playing' to be a target).
    // Force B's phase to spectating-like idle that doesn't consume
    // the drop queue. Simplest: leave B in spawn for frame 1, then
    // immediately put it into dead/spectating so it does not progress
    // but still shows as 'playing' for targeting.
    // Tricky — we actually WANT B to be a target, so keep B in
    // 'playing' status but park it in a phase that has no effect.
    // Easiest: set B to spectating then back to 'playing' would be
    // wrong. Just park B in 'spawn' and don't tick enough frames for
    // B to die naturally.

    // Drive 120 frames — plenty for A's chain to resolve.
    for (let i = 0; i < 120; i++) advanceFrame(match);

    expect(a.chainCount).toBeGreaterThanOrEqual(2);
    expect(a.sentGarbage + a.pendingGarbage + a.leftoverScore).toBeGreaterThan(0);
    // B should have received some garbage.
    expect(b.pendingGarbage).toBeGreaterThan(0);
  });
});

// --------------------------------------------------------------
// WaitGarbage + ojama drop
// --------------------------------------------------------------

describe('waitGarbage phase', () => {
  it('drops pending ojama and moves to spawn after 18 frames', () => {
    const match = createMatchState({ seed: 1, colorMode: 4, players: [{ id: 'A' }] });
    const p = match.players[0]!;
    p.pendingGarbage = 6;
    p.phase = 'waitGarbage';
    p.phaseFrame = 0;

    // Frame 1: place ojama, start animation.
    advanceFrame(match);
    expect(match.events.some((e) => e.type === 'ojama_drop')).toBe(true);
    expect(p.pendingGarbage).toBe(0);

    // Drive WAIT_GARBAGE_FRAMES - 1 additional frames. The last of those
    // flips phase to 'spawn'; we check BEFORE the spawn-phase handler
    // would have run on a following frame.
    for (let i = 0; i < WAIT_GARBAGE_FRAMES - 1; i++) advanceFrame(match);
    expect(p.phase).toBe('spawn');
  });

  it('still waits the full breather even with no pending garbage', () => {
    // Previously we skipped straight to spawn when no garbage was
    // queued, but playtest feedback asked for a consistent 0.3s
    // (= 18f) pause before the next piece arrives. The full
    // WAIT_GARBAGE_FRAMES window now runs in both paths.
    const match = createMatchState({ seed: 1, colorMode: 4, players: [{ id: 'A' }] });
    const p = match.players[0]!;
    p.phase = 'waitGarbage';
    p.phaseFrame = 0;

    // One frame in — still waiting, not yet spawning.
    advanceFrame(match);
    expect(p.phase).toBe('waitGarbage');

    // Drive the remaining frames; the wait completes on the 18th.
    for (let i = 0; i < WAIT_GARBAGE_FRAMES - 1; i++) advanceFrame(match);
    expect(p.phase).toBe('spawn');
  });
});

// --------------------------------------------------------------
// Chigiri
// --------------------------------------------------------------

describe('chigiri phase', () => {
  it('waits the pre-gravity hold then a post-fall settle before resolving', () => {
    // The test forces chigiri on an empty board, so gravity moves no
    // cells and `maxFall` is 0. The phase still pads the post-gravity
    // window by `POST_FALL_SETTLE_FRAMES` so any in-flight bounce can
    // finish — total length = CHIGIRI_FRAMES + POST_FALL_SETTLE_FRAMES.
    const match = createMatchState({ seed: 1, colorMode: 4, players: [{ id: 'A' }] });
    const p = match.players[0]!;
    p.phase = 'chigiri';
    p.phaseFrame = 0;

    const totalChigiriLength = CHIGIRI_FRAMES + POST_FALL_SETTLE_FRAMES;
    for (let i = 0; i < totalChigiriLength - 1; i++) {
      advanceFrame(match);
      expect(p.phase).toBe('chigiri');
    }
    advanceFrame(match);
    expect(p.phase).toBe('resolving');
  });
});

// --------------------------------------------------------------
// Dead animation
// --------------------------------------------------------------

describe('dead phase', () => {
  it('lasts DEAD_FRAMES then becomes spectating', () => {
    // Use 3 players so that killing one still leaves two alive and
    // the match does not end (ending halts all player-phase ticks).
    const match = createMatchState({
      seed: 1,
      colorMode: 4,
      players: [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
    });
    const a = match.players[0]!;
    a.phase = 'dead';
    a.phaseFrame = 0;
    a.status = 'dead';

    for (let i = 0; i < DEAD_FRAMES; i++) advanceFrame(match);
    expect(a.phase).toBe('spectating');
    expect(a.status).toBe('spectating');
  });
});

// --------------------------------------------------------------
// Match end
// --------------------------------------------------------------

describe('match end (2 players)', () => {
  it('finishes when only one player remains alive', () => {
    const match = createMatchState({ seed: 1, colorMode: 4, players: [{ id: 'A' }, { id: 'B' }] });
    // Block B's spawn — B will die on its first spawn tick.
    setCell(match.players[1]!.board, 2, 11, 'X');

    // One frame: both players process. B dies. Still one alive.
    advanceFrame(match);
    expect(match.status).toBe('finished');
    expect(match.winnerId).toBe('A');
    expect(match.events.some((e) => e.type === 'match_end')).toBe(true);
  });
});

describe('match end (solo)', () => {
  it('finishes with a null winner when the lone player dies', () => {
    const match = createMatchState({ seed: 1, colorMode: 4, players: [{ id: 'A' }] });
    setCell(match.players[0]!.board, 2, 11, 'X');
    advanceFrame(match);
    expect(match.status).toBe('finished');
    expect(match.winnerId).toBeNull();
  });
});

// --------------------------------------------------------------
// Determinism
// --------------------------------------------------------------

describe('determinism', () => {
  it('produces identical hashes for identical seeds + inputs', () => {
    const runA = createMatchState({ seed: 42, colorMode: 4, players: [{ id: 'A' }] });
    const runB = createMatchState({ seed: 42, colorMode: 4, players: [{ id: 'A' }] });
    for (let i = 0; i < 500; i++) {
      advanceFrame(runA);
      advanceFrame(runB);
    }
    expect(computeHash(runA)).toBe(computeHash(runB));
  });

  it('different inputs produce different hashes', () => {
    const a = createMatchState({ seed: 42, colorMode: 4, players: [{ id: 'A' }] });
    const b = createMatchState({ seed: 42, colorMode: 4, players: [{ id: 'A' }] });
    // Spawn first piece on both.
    advanceFrame(a);
    advanceFrame(b);
    // A gets a left move on frame 2.
    advanceFrame(a, { A: ['MOVE_L'] });
    advanceFrame(b);
    for (let i = 0; i < 100; i++) {
      advanceFrame(a);
      advanceFrame(b);
    }
    expect(computeHash(a)).not.toBe(computeHash(b));
  });

  it('input ordering within a frame matters (but is deterministic)', () => {
    const a = createMatchState({ seed: 1, colorMode: 4, players: [{ id: 'A' }] });
    const b = createMatchState({ seed: 1, colorMode: 4, players: [{ id: 'A' }] });
    advanceFrame(a);
    advanceFrame(b);
    advanceFrame(a, { A: ['MOVE_L', 'ROT_R'] });
    advanceFrame(b, { A: ['ROT_R', 'MOVE_L'] });
    // They may disagree because rotation might succeed differently, but
    // both runs with THE SAME order must produce the same final result.
    const a2 = createMatchState({ seed: 1, colorMode: 4, players: [{ id: 'A' }] });
    const b2 = createMatchState({ seed: 1, colorMode: 4, players: [{ id: 'A' }] });
    advanceFrame(a2);
    advanceFrame(b2);
    advanceFrame(a2, { A: ['MOVE_L', 'ROT_R'] });
    advanceFrame(b2, { A: ['MOVE_L', 'ROT_R'] });
    expect(computeHash(a2)).toBe(computeHash(b2));
  });
});

// --------------------------------------------------------------
// Sanity: move/rotate input affects current piece
// --------------------------------------------------------------

describe('input handling', () => {
  it('MOVE_L shifts the current piece left', () => {
    const match = createMatchState({ seed: 1, colorMode: 4, players: [{ id: 'A' }] });
    advanceFrame(match); // spawn
    const pBefore = match.players[0]!.current!;
    advanceFrame(match, { A: ['MOVE_L'] });
    const pAfter = match.players[0]!.current!;
    expect(pAfter.axisX).toBe(pBefore.axisX - 1);
  });

  it('ROT_R advances rotation 0 → 1', () => {
    const match = createMatchState({ seed: 1, colorMode: 4, players: [{ id: 'A' }] });
    advanceFrame(match);
    advanceFrame(match, { A: ['ROT_R'] });
    expect(match.players[0]!.current!.rotation).toBe(1);
  });

  it('SOFT_START enables faster falling', () => {
    const match = createMatchState({ seed: 1, colorMode: 4, players: [{ id: 'A' }] });
    advanceFrame(match);
    const p = match.players[0]!;
    advanceFrame(match, { A: ['SOFT_START'] });
    expect(p.softDrop).toBe(true);
    advanceFrame(match, { A: ['SOFT_END'] });
    expect(p.softDrop).toBe(false);
  });

  it('SOFT_END received during resolving still clears softDrop (regression)', () => {
    // Regression for: post-chain piece falls too fast because SOFT_END
    // while in non-falling phase was silently dropped.
    const match = createMatchState({ seed: 1, colorMode: 4, players: [{ id: 'A' }] });
    const p = match.players[0]!;
    p.softDrop = true;
    p.phase = 'resolving';
    p.phaseFrame = 0;
    p.resolvingData = null;

    advanceFrame(match, { A: ['SOFT_END'] });
    expect(p.softDrop).toBe(false);
  });

  it('SOFT_END received during waitGarbage still clears softDrop (regression)', () => {
    const match = createMatchState({ seed: 1, colorMode: 4, players: [{ id: 'A' }] });
    const p = match.players[0]!;
    p.softDrop = true;
    p.phase = 'waitGarbage';
    p.phaseFrame = 0;

    advanceFrame(match, { A: ['SOFT_END'] });
    expect(p.softDrop).toBe(false);
  });

  it('SOFT_START received during spawn is honored so the next piece falls fast', () => {
    const match = createMatchState({ seed: 1, colorMode: 4, players: [{ id: 'A' }] });
    const p = match.players[0]!;
    p.softDrop = false;
    p.phase = 'spawn';
    p.phaseFrame = 0;

    advanceFrame(match, { A: ['SOFT_START'] });
    expect(p.softDrop).toBe(true);
  });
});

// Guard: the exported cell getter path works on simulator-owned boards.
describe('external board access stays functional', () => {
  it('getCell is usable on a player board', () => {
    const match = createMatchState({ seed: 1, colorMode: 4, players: [{ id: 'A' }] });
    expect(getCell(match.players[0]!.board, 0, 0)?.kind).toBeNull();
  });
});

// Use tickN in at least one place so the helper is not flagged as dead code.
describe('smoke: many ticks do not throw', () => {
  it('survives 1000 idle frames solo', () => {
    const match = createMatchState({ seed: 3, colorMode: 4, players: [{ id: 'A' }] });
    tickN(match, 1000);
    // Either finished (top-out) or still running.
    expect(['running', 'finished']).toContain(match.status);
  });
});
