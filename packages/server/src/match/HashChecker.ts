/**
 * HashChecker — collects per-frame STATE_HASH submissions from every
 * player in a match and surfaces a desync the instant the set of
 * unique hashes for a frame is greater than one.
 *
 * See D4 §4.3 and D6 §8.
 */

import type { PlayerId } from '@chaindrop/shared/protocol';

export interface HashCheckerOptions {
  playerOrder: readonly PlayerId[];
  onMismatch: (frame: number, hashes: Record<PlayerId, string>) => void;
}

/** How many partial frame-buckets to keep before evicting the oldest. */
const MAX_OPEN_BUCKETS = 64;

export class HashChecker {
  private buffer = new Map<number, Map<PlayerId, string>>();
  /** Frames already reported as a mismatch, so we never double-fire. */
  private readonly fired = new Set<number>();
  private readonly playerSet: ReadonlySet<PlayerId>;

  constructor(private readonly opts: HashCheckerOptions) {
    this.playerSet = new Set(opts.playerOrder);
  }

  submit(playerId: PlayerId, frame: number, hash: string): void {
    if (!this.playerSet.has(playerId)) return;
    if (this.fired.has(frame)) return; // already resolved as a mismatch

    let bucket = this.buffer.get(frame);
    if (!bucket) {
      bucket = new Map();
      this.buffer.set(frame, bucket);
      this.evictStaleBuckets();
    }
    bucket.set(playerId, hash);

    // EARLY detection: the instant two submitted hashes disagree, fire —
    // don't wait for everyone. If a desynced peer crashes (and never
    // sends its remaining hashes) the old "wait for all" logic would
    // never detect the desync and the match would hang. We only need
    // two conflicting values to know the sim diverged.
    const unique = new Set(bucket.values());
    if (unique.size > 1) {
      const hashes: Record<PlayerId, string> = {};
      for (const [pid, h] of bucket) hashes[pid] = h;
      this.buffer.delete(frame);
      this.fired.add(frame);
      this.opts.onMismatch(frame, hashes);
      return;
    }

    // All hashes so far agree; once everyone has reported we can retire
    // the bucket (a clean frame).
    if (bucket.size === this.playerSet.size) {
      this.buffer.delete(frame);
    }
  }

  /**
   * Bound memory if a player permanently stops submitting (its buckets
   * would otherwise linger forever). Drop the lowest open frames once
   * we exceed the cap — a frame this old is no longer actionable.
   */
  private evictStaleBuckets(): void {
    while (this.buffer.size > MAX_OPEN_BUCKETS) {
      const oldest = this.buffer.keys().next().value;
      if (oldest === undefined) break;
      this.buffer.delete(oldest);
    }
  }

  dispose(): void {
    this.buffer.clear();
    this.fired.clear();
  }
}
