import { describe, expect, it } from 'vitest';
import { InputSystem } from './InputSystem';
import type { KeyboardTarget } from './KeyboardInput';

class FakeTarget implements KeyboardTarget {
  private listeners = {
    keydown: new Set<(e: KeyboardEvent) => void>(),
    keyup: new Set<(e: KeyboardEvent) => void>(),
  };
  addEventListener(t: 'keydown' | 'keyup', fn: (e: KeyboardEvent) => void) {
    this.listeners[t].add(fn);
  }
  removeEventListener(t: 'keydown' | 'keyup', fn: (e: KeyboardEvent) => void) {
    this.listeners[t].delete(fn);
  }
  dispatch(type: 'keydown' | 'keyup', code: string): void {
    const ev = { code, preventDefault() {} } as unknown as KeyboardEvent;
    for (const fn of this.listeners[type]) fn(ev);
  }
}

describe('InputSystem', () => {
  it('emits the initial tap immediately, then DAS/ARR repeats', () => {
    const sys = new InputSystem({ das: 3, arr: 2 });
    const t = new FakeTarget();
    sys.attach(t);

    t.dispatch('keydown', 'ArrowLeft');
    // Frame 1: tap emits MOVE_L, DAS tick sees holdFrames=1 → no repeat
    expect(sys.consume()).toEqual(['MOVE_L']);
    // Frame 2 (holdFrames=2): no repeat yet
    expect(sys.consume()).toEqual([]);
    // Frame 3 (holdFrames=3=das): first repeat
    expect(sys.consume()).toEqual(['MOVE_L']);
    // Frame 4 (holdFrames=4): no repeat
    expect(sys.consume()).toEqual([]);
    // Frame 5 (holdFrames=5 = das + arr): second repeat
    expect(sys.consume()).toEqual(['MOVE_L']);
  });

  it('ends repeats on keyup', () => {
    const sys = new InputSystem({ das: 2, arr: 1 });
    const t = new FakeTarget();
    sys.attach(t);
    t.dispatch('keydown', 'ArrowRight');
    sys.consume(); // tap + no repeat
    sys.consume(); // repeat (das=2)
    t.dispatch('keyup', 'ArrowRight');
    expect(sys.consume()).toEqual([]);
    expect(sys.consume()).toEqual([]);
  });

  it('passes through rotations without repeats', () => {
    const sys = new InputSystem();
    const t = new FakeTarget();
    sys.attach(t);
    t.dispatch('keydown', 'KeyX');
    expect(sys.consume()).toEqual(['ROT_R']);
    // Holding rotate does not auto-repeat.
    for (let i = 0; i < 30; i++) expect(sys.consume()).toEqual([]);
  });

  it('setBindings updates the keyboard layout', () => {
    const sys = new InputSystem();
    const t = new FakeTarget();
    sys.attach(t);
    sys.setBindings({
      MOVE_L: 'KeyA',
      MOVE_R: 'KeyD',
      SOFT_DROP: 'KeyS',
      ROT_L: 'KeyQ',
      ROT_R: 'KeyE',
      PAUSE: 'Escape',
    });
    t.dispatch('keydown', 'KeyA');
    expect(sys.consume()).toEqual(['MOVE_L']);
  });

  it('dispose detaches listeners and clears DAS state', () => {
    const sys = new InputSystem();
    const t = new FakeTarget();
    sys.attach(t);
    t.dispatch('keydown', 'ArrowLeft');
    sys.dispose();
    // After dispose, no further events flow.
    t.dispatch('keydown', 'ArrowRight');
    expect(sys.consume()).toEqual([]);
  });
});
