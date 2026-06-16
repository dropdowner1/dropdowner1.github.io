import { describe, expect, it } from 'vitest';
import { HashChecker } from './HashChecker';

describe('HashChecker', () => {
  it('does nothing while a frame is still partial', () => {
    let calls = 0;
    const c = new HashChecker({
      playerOrder: ['A', 'B'],
      onMismatch: () => calls++,
    });
    c.submit('A', 0, 'h0');
    expect(calls).toBe(0);
  });

  it('stays silent when every player reports the same hash for a frame', () => {
    let calls = 0;
    const c = new HashChecker({
      playerOrder: ['A', 'B'],
      onMismatch: () => calls++,
    });
    c.submit('A', 0, 'same');
    c.submit('B', 0, 'same');
    expect(calls).toBe(0);
  });

  it('fires onMismatch with the offending hashes when they diverge', () => {
    const events: Array<{ frame: number; hashes: Record<string, string> }> = [];
    const c = new HashChecker({
      playerOrder: ['A', 'B'],
      onMismatch: (frame, hashes) => events.push({ frame, hashes }),
    });
    c.submit('A', 42, 'left');
    c.submit('B', 42, 'right');
    expect(events).toEqual([{ frame: 42, hashes: { A: 'left', B: 'right' } }]);
  });

  it('ignores submissions from players outside the announced roster', () => {
    let calls = 0;
    const c = new HashChecker({
      playerOrder: ['A', 'B'],
      onMismatch: () => calls++,
    });
    c.submit('A', 0, 'a');
    c.submit('C', 0, 'c');
    c.submit('B', 0, 'b');
    // Mismatch should fire on the (A, B) pair alone — C never counted.
    expect(calls).toBe(1);
  });

  it('detects a desync EARLY without waiting for the third player', () => {
    // A desynced peer can crash and never send its hash. With the old
    // "wait for everyone" logic the mismatch was never reported and the
    // match hung. Two conflicting hashes are enough to know.
    const events: Array<{ frame: number }> = [];
    const c = new HashChecker({
      playerOrder: ['A', 'B', 'C'],
      onMismatch: (frame) => events.push({ frame }),
    });
    c.submit('A', 7, 'x');
    c.submit('B', 7, 'y'); // disagrees with A — fire now, C never reports
    expect(events).toEqual([{ frame: 7 }]);
  });

  it('does not double-fire if more hashes arrive for an already-flagged frame', () => {
    let calls = 0;
    const c = new HashChecker({
      playerOrder: ['A', 'B', 'C'],
      onMismatch: () => calls++,
    });
    c.submit('A', 1, 'x');
    c.submit('B', 1, 'y'); // fires
    c.submit('C', 1, 'z'); // late arrival for an already-flagged frame
    expect(calls).toBe(1);
  });
});
