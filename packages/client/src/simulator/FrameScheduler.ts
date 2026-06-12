/**
 * FrameScheduler — the fixed-step game loop driver.
 *
 *   - Consumes real time at the platform's pace (rAF by default).
 *   - Advances the simulator in fixed 1/60 s increments.
 *   - Emits an `alpha` value (0..1) to the renderer so it can
 *     interpolate between the last two frames when drawing.
 *
 * See D5 §12 and D2 §8.1. The scheduler owns the call-every-frame
 * loop; rendering and input are delegated out.
 */

import { type InputAction, type MatchState, advanceFrame } from '@chaindrop/shared';
import type { LocalMatchSource } from './LocalMatchSource';
import type { Frame, MatchSource } from './MatchSource';

/** Target logical framerate — 60 FPS. */
export const FRAME_MS = 1000 / 60;

/** Max accumulated real time per tick, to avoid spiral-of-death on stall. */
export const MAX_ACCUMULATED_MS = 250;

/** Abstraction over `requestAnimationFrame` / `performance.now` for testing. */
export interface Clock {
  now(): number;
  requestFrame(cb: (ts: number) => void): number;
  cancelFrame(handle: number): void;
}

export const DEFAULT_CLOCK: Clock = {
  now: () => performance.now(),
  requestFrame: (cb) => requestAnimationFrame(cb),
  cancelFrame: (handle) => cancelAnimationFrame(handle),
};

export interface InputProducer {
  /** Called once per game frame. Returns the inputs for this frame. */
  consume(): readonly InputAction[];
}

export interface FrameSchedulerOptions {
  source: MatchSource;
  input: InputProducer;
  /** Called after each simulation step (not each render frame). */
  onFrameAdvanced?: (match: MatchState) => void;
  /** Called every rAF with the rendering interpolation alpha ∈ [0, 1). */
  onRender?: (match: MatchState, alpha: number) => void;
  clock?: Clock;
}

export class FrameScheduler {
  private clock: Clock;
  private source: MatchSource;
  private input: InputProducer;
  private onFrameAdvanced: (match: MatchState) => void;
  private onRender: (match: MatchState, alpha: number) => void;

  private accumulator = 0;
  private lastTs = 0;
  private handle = 0;
  private running = false;
  /** True when we stalled on a missing input batch this loop tick. */
  private stalled = false;
  /**
   * Clock timestamp when the current continuous stall began, or 0 when
   * not stalling. Lets a scene measure how long the sim has been frozen
   * waiting on the network so it can warn / abort instead of spinning
   * on the same frame forever.
   */
  private stallStartTs = 0;

  constructor(opts: FrameSchedulerOptions) {
    this.clock = opts.clock ?? DEFAULT_CLOCK;
    this.source = opts.source;
    this.input = opts.input;
    this.onFrameAdvanced = opts.onFrameAdvanced ?? (() => {});
    this.onRender = opts.onRender ?? (() => {});
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTs = this.clock.now();
    this.accumulator = 0;
    this.handle = this.clock.requestFrame((ts) => this.loop(ts));
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.clock.cancelFrame(this.handle);
  }

  /** Whether the most recent loop tick stalled on a missing batch. */
  get isStalled(): boolean {
    return this.stalled;
  }

  /**
   * Milliseconds the sim has been continuously stalled on a missing
   * network batch, or 0 if it's advancing normally. Drives the
   * "通信が不安定です" warning + the eventual connection-lost bail-out.
   */
  stalledForMs(): number {
    if (this.stallStartTs === 0) return 0;
    return Math.max(0, this.clock.now() - this.stallStartTs);
  }

  private loop(ts: number): void {
    if (!this.running) return;

    const dt = Math.min(ts - this.lastTs, MAX_ACCUMULATED_MS);
    this.lastTs = ts;
    this.accumulator += Math.max(0, dt);
    this.stalled = false;

    // Guard against float-precision drift: the running accumulator can
    // end up ~1e-14 below FRAME_MS after several subtractions even when
    // real time was a clean multiple. A tiny epsilon on the threshold
    // keeps the frame count correct without ever running an extra tick.
    const FRAME_THRESHOLD = FRAME_MS - 0.001;
    while (this.accumulator >= FRAME_THRESHOLD) {
      if (!this.stepOnce()) {
        this.stalled = true;
        // Mark the start of a continuous stall the first tick it
        // happens; `stepOnce` success resets it back to 0.
        if (this.stallStartTs === 0) this.stallStartTs = ts;
        break;
      }
      this.stalled = false;
      this.stallStartTs = 0;
      this.accumulator -= FRAME_MS;
    }

    this.onRender(this.source.match, Math.min(this.accumulator / FRAME_MS, 0.9999));

    this.handle = this.clock.requestFrame((t) => this.loop(t));
  }

  /**
   * Consume one local input set, submit it to the source, pull the
   * authoritative batch for the current frame, and advance the sim.
   * Returns `false` when the source has not yet produced a batch
   * (network stall); returns `true` on success.
   */
  private stepOnce(): boolean {
    const frame: Frame = this.source.match.frame;
    const myActions = this.input.consume();
    this.source.submitInput(frame, myActions);
    const batch = this.source.getInputBatch(frame);
    if (batch === null) return false;

    advanceFrame(this.source.match, batch);
    notifyEndIfLocal(this.source);
    this.onFrameAdvanced(this.source.match);
    return true;
  }

  /**
   * Manually advance exactly N simulation frames, ignoring wall clock.
   * Useful for deterministic tests and headless benches.
   */
  advanceManual(frames: number): void {
    for (let i = 0; i < frames; i++) {
      if (!this.stepOnce()) return;
    }
  }

  dispose(): void {
    this.stop();
  }
}

function notifyEndIfLocal(source: MatchSource): void {
  // LocalMatchSource needs an explicit nudge to fire its endHandlers.
  // Network sources will fire via server events instead.
  const asLocal = source as Partial<Pick<LocalMatchSource, 'notifyIfEnded'>>;
  if (typeof asLocal.notifyIfEnded === 'function') {
    asLocal.notifyIfEnded();
  }
}
