/**
 * MatchSource — abstraction over the authoritative input source.
 *
 * Solo mode uses `LocalMatchSource`, which simply echoes back the
 * locally-submitted inputs on the SAME frame. Online mode will later
 * plug in a network-backed source that defers by 3 frames and waits
 * for the server to confirm everyone's batch (lockstep).
 *
 * The simulator itself is agnostic of which implementation it is
 * driven by; the scheduler only talks to this interface.
 */

import type { InputAction, MatchState, PlayerId } from '@chaindrop/shared';

export type Frame = number;

export interface InputBatch {
  [playerId: PlayerId]: readonly InputAction[];
}

/**
 * Why a match ended. `normal` is a clean win/loss/draw; `desync` means
 * a server-confirmed determinism mismatch (an invalid match that must
 * not be recorded in win/loss stats). Solo always reports `normal`.
 */
export type MatchEndReason = 'normal' | 'desync';

export type MatchEndHandler = (winnerId: PlayerId | null, reason: MatchEndReason) => void;

export interface MatchSource {
  readonly myPlayerId: PlayerId;
  readonly match: MatchState;

  /** Submit this client's inputs collected during the current game frame. */
  submitInput(currentFrame: Frame, actions: readonly InputAction[]): void;

  /**
   * Return the authoritative input batch for `frame`, or `null` if it
   * is not yet available (network stalling, etc.). Callers are
   * expected to call once per tick and wait if null.
   */
  getInputBatch(frame: Frame): InputBatch | null;

  /** Called when the underlying match transitions to `finished`. */
  onMatchEnd(fn: MatchEndHandler): void;

  /** Release resources (network subs, buffers, etc.). Idempotent. */
  dispose(): void;
}
