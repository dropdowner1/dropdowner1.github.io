import type { Room } from 'colyseus.js';
import { describe, expect, it, vi } from 'vitest';
import { NetworkedMatchSource } from './NetworkedMatchSource';

/**
 * Minimal fake Colyseus Room: records onMessage handlers by type and
 * lets a test dispatch a raw payload to them, plus stubs the lifecycle
 * hooks NetworkedMatchSource subscribes to.
 */
function makeFakeRoom() {
  const handlers = new Map<string, (raw: unknown) => void>();
  let leaveCb: (() => void) | null = null;
  let errorCb: (() => void) | null = null;
  const sent: Array<{ type: string; payload: unknown }> = [];
  const room = {
    sessionId: 'p1',
    onMessage: (type: string, cb: (raw: unknown) => void) => {
      handlers.set(type, cb);
    },
    onLeave: (cb: () => void) => {
      leaveCb = cb;
    },
    onError: (cb: () => void) => {
      errorCb = cb;
    },
    send: (type: string, payload: unknown) => {
      sent.push({ type, payload });
    },
    leave: vi.fn(() => Promise.resolve()),
  } as unknown as Room<unknown>;
  return {
    room,
    sent,
    dispatch: (type: string, payload: unknown) => handlers.get(type)?.(payload),
    fireLeave: () => leaveCb?.(),
    fireError: () => errorCb?.(),
  };
}

function makeSource(room: Room<unknown>) {
  return new NetworkedMatchSource({
    room,
    playerOrder: ['p1', 'p2'],
    myPlayerId: 'p1',
    seed: 1,
    colorMode: 4,
    dropQueue: [
      ['R', 'G'],
      ['B', 'Y'],
    ],
  });
}

describe('NetworkedMatchSource.notifyIfEnded (CD-2)', () => {
  it('fires the end handler with reason "normal" when the local sim finishes', () => {
    const fake = makeFakeRoom();
    const source = makeSource(fake.room);
    const onEnd = vi.fn();
    source.onMatchEnd(onEnd);

    // Simulate the deterministic sim reaching a clean win locally.
    source.match.status = 'finished';
    source.match.winnerId = 'p1';
    source.notifyIfEnded();

    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith('p1', 'normal');
  });

  it('is a no-op while the match is still running', () => {
    const fake = makeFakeRoom();
    const source = makeSource(fake.room);
    const onEnd = vi.fn();
    source.onMatchEnd(onEnd);
    source.notifyIfEnded();
    expect(onEnd).not.toHaveBeenCalled();
  });

  it('only fires once even if notifyIfEnded is called repeatedly', () => {
    const fake = makeFakeRoom();
    const source = makeSource(fake.room);
    const onEnd = vi.fn();
    source.onMatchEnd(onEnd);
    source.match.status = 'finished';
    source.match.winnerId = null;
    source.notifyIfEnded();
    source.notifyIfEnded();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});

describe('NetworkedMatchSource server events', () => {
  it('MATCH_END fires the handler with reason "normal"', () => {
    const fake = makeFakeRoom();
    const source = makeSource(fake.room);
    const onEnd = vi.fn();
    source.onMatchEnd(onEnd);
    fake.dispatch('MATCH_END', { winnerId: 'p2' });
    expect(onEnd).toHaveBeenCalledWith('p2', 'normal');
  });

  it('DESYNC_DETECTED fires the handler with reason "desync"', () => {
    const fake = makeFakeRoom();
    const source = makeSource(fake.room);
    const onEnd = vi.fn();
    source.onMatchEnd(onEnd);
    fake.dispatch('DESYNC_DETECTED', { frame: 10, hashes: {} });
    expect(onEnd).toHaveBeenCalledWith(null, 'desync');
  });

  it('a server MATCH_END after a local finish does not double-fire', () => {
    const fake = makeFakeRoom();
    const source = makeSource(fake.room);
    const onEnd = vi.fn();
    source.onMatchEnd(onEnd);
    source.match.status = 'finished';
    source.match.winnerId = 'p1';
    source.notifyIfEnded();
    fake.dispatch('MATCH_END', { winnerId: 'p1' });
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});

describe('NetworkedMatchSource connection loss', () => {
  it('fires onConnectionLost when the socket drops before a finish', () => {
    const fake = makeFakeRoom();
    const source = makeSource(fake.room);
    const lost = vi.fn();
    source.onConnectionLost(lost);
    fake.fireLeave();
    expect(lost).toHaveBeenCalledTimes(1);
  });

  it('does NOT report connection loss after a clean finish', () => {
    const fake = makeFakeRoom();
    const source = makeSource(fake.room);
    const lost = vi.fn();
    source.onConnectionLost(lost);
    source.match.status = 'finished';
    source.notifyIfEnded();
    fake.fireLeave();
    expect(lost).not.toHaveBeenCalled();
  });

  it('leaveRoom sends LEAVE_MATCH and leaves the room', () => {
    const fake = makeFakeRoom();
    const source = makeSource(fake.room);
    source.leaveRoom();
    expect(fake.sent.some((m) => m.type === 'LEAVE_MATCH')).toBe(true);
    expect(fake.room.leave).toHaveBeenCalled();
  });
});

describe('NetworkedMatchSource MATCH_BEGIN sync', () => {
  it('starts un-begun and flips hasBegun on MATCH_BEGIN', () => {
    const fake = makeFakeRoom();
    const source = makeSource(fake.room);
    expect(source.hasBegun).toBe(false);
    fake.dispatch('MATCH_BEGIN', {});
    expect(source.hasBegun).toBe(true);
  });

  it('fires an onBegin handler registered BEFORE MATCH_BEGIN arrives', () => {
    const fake = makeFakeRoom();
    const source = makeSource(fake.room);
    const begin = vi.fn();
    source.onBegin(begin);
    expect(begin).not.toHaveBeenCalled();
    fake.dispatch('MATCH_BEGIN', {});
    expect(begin).toHaveBeenCalledTimes(1);
  });

  it('runs an onBegin handler immediately if MATCH_BEGIN already arrived', () => {
    const fake = makeFakeRoom();
    const source = makeSource(fake.room);
    fake.dispatch('MATCH_BEGIN', {});
    const begin = vi.fn();
    source.onBegin(begin);
    expect(begin).toHaveBeenCalledTimes(1);
  });

  it('only fires onBegin once even on a duplicate MATCH_BEGIN', () => {
    const fake = makeFakeRoom();
    const source = makeSource(fake.room);
    const begin = vi.fn();
    source.onBegin(begin);
    fake.dispatch('MATCH_BEGIN', {});
    fake.dispatch('MATCH_BEGIN', {});
    expect(begin).toHaveBeenCalledTimes(1);
  });
});

describe('NetworkedMatchSource input-delay batching', () => {
  it('pre-fills the first inputDelay frames so the sim never stalls at boot', () => {
    const fake = makeFakeRoom();
    // inputDelay 5 for a compact assertion.
    const source = new NetworkedMatchSource({
      room: fake.room,
      playerOrder: ['p1', 'p2'],
      myPlayerId: 'p1',
      seed: 1,
      colorMode: 4,
      dropQueue: [['R', 'G']],
      inputDelay: 5,
    });
    // Frames 0..4 are pre-populated (empty batches) so the scheduler can
    // advance them without waiting on the network.
    for (let f = 0; f < 5; f++) {
      expect(source.getInputBatch(f)).not.toBeNull();
    }
    // Frame 5 has no batch yet — the server hasn't confirmed it.
    expect(source.getInputBatch(5)).toBeNull();
  });

  it('submits local input tagged for currentFrame + inputDelay', () => {
    const fake = makeFakeRoom();
    const source = new NetworkedMatchSource({
      room: fake.room,
      playerOrder: ['p1', 'p2'],
      myPlayerId: 'p1',
      seed: 1,
      colorMode: 4,
      dropQueue: [['R', 'G']],
      inputDelay: 5,
    });
    source.submitInput(3, ['MOVE_L']);
    const input = fake.sent.find((m) => m.type === 'INPUT');
    expect(input?.payload).toMatchObject({ frame: 8, actions: ['MOVE_L'] });
  });

  it('returns a server-confirmed INPUT_BATCH for a future frame', () => {
    const fake = makeFakeRoom();
    const source = new NetworkedMatchSource({
      room: fake.room,
      playerOrder: ['p1', 'p2'],
      myPlayerId: 'p1',
      seed: 1,
      colorMode: 4,
      dropQueue: [['R', 'G']],
      inputDelay: 5,
    });
    fake.dispatch('INPUT_BATCH', { frame: 5, inputs: { p1: ['MOVE_R'], p2: [] } });
    expect(source.getInputBatch(5)).toEqual({ p1: ['MOVE_R'], p2: [] });
  });
});
