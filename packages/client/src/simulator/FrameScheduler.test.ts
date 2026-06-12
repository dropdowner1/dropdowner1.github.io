import { type InputAction, setCell } from '@chaindrop/shared';
import { describe, expect, it } from 'vitest';
import { type Clock, FRAME_MS, FrameScheduler } from './FrameScheduler';
import { LocalMatchSource } from './LocalMatchSource';

/**
 * Deterministic test clock. The loop callback is staged and only fired
 * when the test explicitly advances real time via `tick()`.
 */
class FakeClock implements Clock {
  private current = 0;
  private pending: { handle: number; at: number; cb: (ts: number) => void }[] = [];
  private nextHandle = 1;

  now(): number {
    return this.current;
  }

  requestFrame(cb: (ts: number) => void): number {
    const handle = this.nextHandle++;
    this.pending.push({ handle, at: this.current, cb });
    return handle;
  }

  cancelFrame(handle: number): void {
    this.pending = this.pending.filter((p) => p.handle !== handle);
  }

  /**
   * Advance real time by `dtMs` and fire exactly one pending frame
   * callback (the one requested earliest that is still pending).
   */
  tick(dtMs: number): void {
    this.current += dtMs;
    const next = this.pending.shift();
    if (next) next.cb(this.current);
  }
}

class ScriptedInput {
  private queue: InputAction[][] = [];
  push(actions: InputAction[]) {
    this.queue.push(actions);
  }
  consume(): readonly InputAction[] {
    return this.queue.shift() ?? [];
  }
}

describe('FrameScheduler — manual advance (pure logic)', () => {
  it('advances exactly N frames with advanceManual', () => {
    const source = new LocalMatchSource({ seed: 1, colorMode: 4 });
    const input = new ScriptedInput();
    const sched = new FrameScheduler({ source, input });
    sched.advanceManual(5);
    expect(source.match.frame).toBe(5);
  });

  it('feeds scripted inputs into the simulator', () => {
    const source = new LocalMatchSource({ seed: 1, colorMode: 4 });
    const input = new ScriptedInput();
    const sched = new FrameScheduler({ source, input });

    sched.advanceManual(1); // frame 1: spawn → falling
    const before = source.match.players[0]!.current!.axisX;

    input.push(['MOVE_L']);
    sched.advanceManual(1);
    const after = source.match.players[0]!.current!.axisX;
    expect(after).toBe(before - 1);
  });

  it('onFrameAdvanced fires after each logical step', () => {
    const source = new LocalMatchSource({ seed: 1, colorMode: 4 });
    const input = new ScriptedInput();
    let count = 0;
    const sched = new FrameScheduler({
      source,
      input,
      onFrameAdvanced: () => {
        count++;
      },
    });
    sched.advanceManual(10);
    expect(count).toBe(10);
  });
});

describe('FrameScheduler — real-time loop with FakeClock', () => {
  it('ticks one logical frame per ~16.66ms of real time', () => {
    const clock = new FakeClock();
    const source = new LocalMatchSource({ seed: 1, colorMode: 4 });
    const input = new ScriptedInput();
    const sched = new FrameScheduler({ source, input, clock });

    sched.start();
    // Before the first rAF fires, frame has not advanced.
    expect(source.match.frame).toBe(0);

    // Fire the first rAF at t=0: no dt accumulated yet → 0 logical ticks.
    clock.tick(0);
    expect(source.match.frame).toBe(0);

    // Advance 4 × FRAME_MS of real time before the next rAF.
    clock.tick(FRAME_MS * 4);
    expect(source.match.frame).toBe(4);
  });

  it('does not advance the sim if real time has not accumulated a frame', () => {
    const clock = new FakeClock();
    const source = new LocalMatchSource({ seed: 1, colorMode: 4 });
    const input = new ScriptedInput();
    const sched = new FrameScheduler({ source, input, clock });

    sched.start();
    clock.tick(0);
    clock.tick(5); // less than 1 frame
    expect(source.match.frame).toBe(0);
    clock.tick(5);
    expect(source.match.frame).toBe(0);
    clock.tick(10); // now ~20ms total → 1 frame
    expect(source.match.frame).toBe(1);
  });

  it('clamps catch-up to avoid spiral-of-death', () => {
    const clock = new FakeClock();
    const source = new LocalMatchSource({ seed: 1, colorMode: 4 });
    const input = new ScriptedInput();
    const sched = new FrameScheduler({ source, input, clock });

    sched.start();
    clock.tick(0);
    // A giant 10s freeze: should cap at MAX_ACCUMULATED_MS (250ms)
    // which fits ~15 frames only, not 600.
    clock.tick(10_000);
    expect(source.match.frame).toBeLessThanOrEqual(20);
  });

  it('stop halts further logical advancement', () => {
    const clock = new FakeClock();
    const source = new LocalMatchSource({ seed: 1, colorMode: 4 });
    const input = new ScriptedInput();
    const sched = new FrameScheduler({ source, input, clock });

    sched.start();
    clock.tick(0);
    clock.tick(FRAME_MS * 3);
    const frameAtStop = source.match.frame;
    sched.stop();
    clock.tick(FRAME_MS * 10);
    expect(source.match.frame).toBe(frameAtStop);
  });

  it('onRender is called on every real rAF tick', () => {
    const clock = new FakeClock();
    const source = new LocalMatchSource({ seed: 1, colorMode: 4 });
    const input = new ScriptedInput();
    let renderCalls = 0;
    const sched = new FrameScheduler({
      source,
      input,
      clock,
      onRender: () => {
        renderCalls++;
      },
    });
    sched.start();
    clock.tick(0);
    clock.tick(FRAME_MS);
    clock.tick(FRAME_MS);
    expect(renderCalls).toBeGreaterThanOrEqual(3);
  });

  it('fires LocalMatchSource end handler when the match finishes', () => {
    const source = new LocalMatchSource({ seed: 1, colorMode: 4 });
    // Force a quick death: block the child spawn cell.
    setCell(source.match.players[0]!.board, 2, 11, 'X');
    let winner: string | null | undefined;
    source.onMatchEnd((w) => {
      winner = w;
    });
    const input = new ScriptedInput();
    const sched = new FrameScheduler({ source, input });
    sched.advanceManual(1);
    expect(winner).toBeNull();
  });
});

describe('FrameScheduler — stall detection (TO-5)', () => {
  // A source that never produces a batch — simulates a network stall.
  function stallingSource(): LocalMatchSource {
    const source = new LocalMatchSource({ seed: 1, colorMode: 4 });
    // Override getInputBatch to always report "not ready yet".
    (source as unknown as { getInputBatch: () => null }).getInputBatch = () => null;
    return source;
  }

  it('reports 0 stalled-ms while advancing normally', () => {
    const source = new LocalMatchSource({ seed: 1, colorMode: 4 });
    const clock = new FakeClock();
    const sched = new FrameScheduler({ source, input: new ScriptedInput(), clock });
    sched.start();
    clock.tick(0);
    clock.tick(FRAME_MS);
    expect(sched.stalledForMs()).toBe(0);
  });

  it('accumulates stalled-ms when the batch never arrives', () => {
    const source = stallingSource();
    const clock = new FakeClock();
    const sched = new FrameScheduler({ source, input: new ScriptedInput(), clock });
    sched.start();
    clock.tick(0); // first loop, establishes lastTs
    clock.tick(FRAME_MS * 3); // tries to step, stalls — stall begins here
    const first = sched.stalledForMs();
    expect(first).toBeGreaterThanOrEqual(0);
    clock.tick(1000); // a full second passes still stalled
    expect(sched.stalledForMs()).toBeGreaterThanOrEqual(1000);
    expect(sched.isStalled).toBe(true);
  });
});
