/**
 * LocalMatchSource — the zero-latency solo implementation of MatchSource.
 *
 * Inputs submitted on frame N are echoed back immediately for the same
 * frame. No network, no queue depth, no stalling.
 *
 * Multiplayer later gets a different implementation that injects a
 * 3-frame delay and blocks until the server confirms everyone's batch.
 */

import {
  type InputAction,
  type MatchConfig,
  type MatchState,
  type PlayerId,
  type PlayerInit,
  createMatchState,
} from '@chaindrop/shared';
import type { Frame, InputBatch, MatchSource } from './MatchSource';

export interface LocalMatchSourceOptions {
  seed: number;
  colorMode: 4 | 5;
  playerId?: PlayerId;
  dropQueueLength?: number;
  /** Starting frames-per-cell for natural gravity (difficulty picker). */
  fallIntervalNormal?: number;
}

export class LocalMatchSource implements MatchSource {
  readonly myPlayerId: PlayerId;
  readonly match: MatchState;

  private buffer = new Map<Frame, readonly InputAction[]>();
  private endHandlers: ((winnerId: PlayerId | null) => void)[] = [];
  private endFired = false;

  constructor(opts: LocalMatchSourceOptions) {
    this.myPlayerId = opts.playerId ?? 'solo';
    const players: PlayerInit[] = [{ id: this.myPlayerId }];
    const config: MatchConfig = {
      seed: opts.seed,
      colorMode: opts.colorMode,
      players,
      ...(opts.dropQueueLength !== undefined && { dropQueueLength: opts.dropQueueLength }),
      ...(opts.fallIntervalNormal !== undefined && {
        fallIntervalNormal: opts.fallIntervalNormal,
      }),
    };
    this.match = createMatchState(config);
  }

  submitInput(currentFrame: Frame, actions: readonly InputAction[]): void {
    // Zero input delay: apply on the same frame.
    this.buffer.set(currentFrame, actions);
  }

  getInputBatch(frame: Frame): InputBatch | null {
    const actions = this.buffer.get(frame) ?? [];
    this.buffer.delete(frame);
    return { [this.myPlayerId]: actions };
  }

  onMatchEnd(fn: (winnerId: PlayerId | null) => void): void {
    this.endHandlers.push(fn);
  }

  /**
   * Called by the scheduler after each `advanceFrame`. Fires the
   * end-of-match callback the first time the match status flips to
   * `finished`.
   */
  notifyIfEnded(): void {
    if (this.endFired) return;
    if (this.match.status !== 'finished') return;
    this.endFired = true;
    for (const fn of this.endHandlers) fn(this.match.winnerId);
  }

  dispose(): void {
    this.buffer.clear();
    this.endHandlers = [];
  }
}
