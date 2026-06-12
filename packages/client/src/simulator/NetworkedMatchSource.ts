/**
 * NetworkedMatchSource — lockstep MatchSource backed by Colyseus.
 *
 * Sits in the same shape as `LocalMatchSource` so the existing
 * `FrameScheduler` can drive an online match without modification:
 *
 *   submitInput(frame, actions) → wire that input to the SERVER tagged
 *                                 for `frame + inputDelay`.
 *   getInputBatch(frame)        → return the authoritative batch the
 *                                 server has confirmed for `frame`, or
 *                                 `null` if it has not arrived yet.
 *
 * Lockstep with input delay: every action is applied D frames after
 * the keystroke. That delay covers the round-trip to the server and
 * back so the local sim is never starved waiting for the batch. See
 * D4 §4 (frame-progress protocol) and D6 §7 (server-side InputRelay).
 *
 * STATE_HASH is sent every `hashEveryFrames` frames so the server can
 * cross-check determinism.
 */

import {
  type InputAction,
  type MatchConfig,
  type MatchState,
  type PlayerId,
  type PlayerInit,
  type PuyoColor,
  computeHash,
  createMatchState,
} from '@chaindrop/shared';
import type { Room } from 'colyseus.js';
import { onMatchMessage } from '../network/colyseusClient';
import type {
  Frame,
  InputBatch,
  MatchEndHandler,
  MatchEndReason,
  MatchSource,
} from './MatchSource';

export interface NetworkedMatchSourceOptions {
  room: Room<unknown>;
  /** Player ids in slot order, exactly as the server announced in MATCH_START. */
  playerOrder: readonly PlayerId[];
  myPlayerId: PlayerId;
  seed: number;
  colorMode: 4 | 5;
  /**
   * Frames the server's drop queue contained. Must match what
   * generateDropQueue produces from `seed` + `colorMode`, but is
   * passed in explicitly so we can sanity-check.
   */
  dropQueue: readonly (readonly [PuyoColor, PuyoColor])[];
  /** Inputs entered locally on frame F apply on the simulator at F + inputDelay. */
  inputDelay?: number;
  /** Frames between STATE_HASH submissions. */
  hashEveryFrames?: number;
}

const DEFAULT_INPUT_DELAY = 4;
const DEFAULT_HASH_INTERVAL = 60;

export class NetworkedMatchSource implements MatchSource {
  readonly myPlayerId: PlayerId;
  readonly match: MatchState;

  private readonly inputDelay: number;
  private readonly hashEveryFrames: number;
  private readonly room: Room<unknown>;
  private readonly pendingBatches = new Map<Frame, InputBatch>();
  private readonly endHandlers: MatchEndHandler[] = [];
  private readonly connectionLostHandlers: (() => void)[] = [];
  private disposed = false;
  private endFired = false;
  private connectionLostFired = false;

  constructor(opts: NetworkedMatchSourceOptions) {
    this.room = opts.room;
    this.myPlayerId = opts.myPlayerId;
    this.inputDelay = opts.inputDelay ?? DEFAULT_INPUT_DELAY;
    this.hashEveryFrames = opts.hashEveryFrames ?? DEFAULT_HASH_INTERVAL;

    const players: PlayerInit[] = opts.playerOrder.map((id, i) => ({ id, slotIndex: i }));
    const config: MatchConfig = {
      seed: opts.seed,
      colorMode: opts.colorMode,
      players,
      dropQueueLength: opts.dropQueue.length,
    };
    this.match = createMatchState(config);

    // The first `inputDelay` frames must run before any locally-typed
    // input could possibly have made the server round-trip back. Pre-
    // populate empty batches so the scheduler isn't stalled at boot.
    for (let f = 0; f < this.inputDelay; f++) {
      this.pendingBatches.set(f, this.emptyBatch(opts.playerOrder));
    }

    // The socket closing mid-match (WiFi drop, server redeploy, the
    // process dying) is a connection loss — surface it so the scene can
    // bail to a clear error instead of freezing on the last frame. We
    // only treat it as a loss if the match hasn't already ended.
    this.room.onLeave(() => this.fireConnectionLost());
    this.room.onError(() => this.fireConnectionLost());

    onMatchMessage(this.room, (msg) => {
      if (this.disposed) return;
      switch (msg.t) {
        case 'INPUT_BATCH': {
          // The wire shape is Record<PlayerId, InputAction[]>; the
          // simulator accepts the same shape directly.
          this.pendingBatches.set(msg.frame, msg.inputs as InputBatch);
          break;
        }
        case 'MATCH_END':
          this.fireEnd(msg.winnerId, 'normal');
          break;
        case 'DESYNC_DETECTED':
          // Server-confirmed desync — end the match but flag it so the
          // UI shows a "通信エラー" result and the stats recorder skips
          // it rather than logging a bogus draw.
          this.fireEnd(null, 'desync');
          break;
        default:
          break;
      }
    });
  }

  submitInput(currentFrame: Frame, actions: readonly InputAction[]): void {
    if (this.disposed) return;
    // Apply locally with `inputDelay` lookahead. The server tags the
    // batch with the same frame, so when the simulator reaches it the
    // input pulls back in along with every other player's actions.
    const targetFrame = currentFrame + this.inputDelay;
    this.room.send('INPUT', { frame: targetFrame, actions: [...actions] });
  }

  getInputBatch(frame: Frame): InputBatch | null {
    const batch = this.pendingBatches.get(frame);
    if (!batch) return null;
    this.pendingBatches.delete(frame);

    // Submit a hash check on the cadence requested. We do it here
    // (post-batch, pre-advance) so the hash is on a fully-settled
    // state shared across everyone.
    if (frame > 0 && frame % this.hashEveryFrames === 0) {
      try {
        this.room.send('STATE_HASH', { frame, hash: computeHash(this.match) });
      } catch {
        /* ignore; hash submission is best-effort */
      }
    }
    return batch;
  }

  onMatchEnd(fn: MatchEndHandler): void {
    this.endHandlers.push(fn);
  }

  /** Fired once when the socket drops before a clean match end. */
  onConnectionLost(fn: () => void): void {
    this.connectionLostHandlers.push(fn);
  }

  /**
   * Called by FrameScheduler after every `advanceFrame` (it duck-types
   * this method, same as LocalMatchSource). Critical: a NORMAL win/loss
   * makes the LOCAL simulator reach `status === 'finished'` from the
   * deterministic input stream — the server does NOT separately emit
   * MATCH_END for a clean top-out. Without firing here the board froze
   * forever and the player had to reload. We fire the local result
   * immediately; if a server-authoritative MATCH_END arrives too, the
   * `endFired` latch makes it a no-op.
   */
  notifyIfEnded(): void {
    if (this.endFired) return;
    if (this.match.status !== 'finished') return;
    this.fireEnd(this.match.winnerId, 'normal');
  }

  dispose(): void {
    this.disposed = true;
    this.pendingBatches.clear();
    this.endHandlers.length = 0;
    this.connectionLostHandlers.length = 0;
  }

  /**
   * Leave the owned room. Call this when the player exits the match
   * (quit/forfeit) so the server frees the room and can award the
   * opponent the forfeit win — the previous code never sent anything,
   * leaving the room open until the socket timed out. Best-effort.
   */
  leaveRoom(): void {
    try {
      this.room.send('LEAVE_MATCH', {});
    } catch {
      /* socket may already be closed */
    }
    void this.room.leave().catch(() => {});
  }

  // ----------------------------------------------------------------

  private emptyBatch(playerOrder: readonly PlayerId[]): InputBatch {
    const out: InputBatch = {};
    for (const id of playerOrder) out[id] = [];
    return out;
  }

  private fireEnd(winnerId: PlayerId | null, reason: MatchEndReason): void {
    if (this.endFired) return;
    this.endFired = true;
    for (const fn of this.endHandlers) fn(winnerId, reason);
  }

  private fireConnectionLost(): void {
    // Don't report a connection loss if the match already ended
    // cleanly — a normal finish leaves the room and that triggers
    // onLeave too.
    if (this.endFired || this.connectionLostFired || this.disposed) return;
    this.connectionLostFired = true;
    for (const fn of this.connectionLostHandlers) fn();
  }
}
