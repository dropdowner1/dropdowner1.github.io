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
