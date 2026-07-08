/**
 * Lockstep integration test.
 *
 * Simulates TWO NetworkedMatchSource clients talking to a mock relay
 * over a network with configurable one-way latency (`L` frames), then
 * drives both in frame-by-frame lockstep and checks:
 *
 *   1. With `inputDelay >= 2L` (delay covers the round-trip), neither
 *      client ever stalls — every frame has its batch ready in time.
 *   2. Both sims stay byte-for-byte identical (equal computeHash), i.e.
 *      the deterministic lockstep holds.
 *   3. With `inputDelay < 2L`, stalls DO occur — proving the input
 *      delay must cover the round-trip (the bug that froze real matches:
 *      inputDelay 4 = 66ms vs a ~500ms US-West server round-trip).
 */

import {
  type InputAction,
  type PlayerId,
  type PuyoColor,
  advanceFrame,
  computeHash,
} from '@chaindrop/shared';
import type { Room } from 'colyseus.js';
import { describe, expect, it } from 'vitest';
import { NetworkedMatchSource } from './NetworkedMatchSource';

const PLAYER_ORDER: PlayerId[] = ['p1', 'p2'];
const DROP_QUEUE: (readonly [PuyoColor, PuyoColor])[] = Array.from(
  { length: 64 },
  () => ['R', 'G'] as const,
);

/** A message scheduled for delivery at a future virtual frame. */
interface Delivery {
  at: number;
  run: () => void;
}

/** Deterministic virtual network — messages arrive after a fixed delay. */
class Net {
  private queue: Delivery[] = [];
  vt = 0;
  schedule(delayFrames: number, run: () => void): void {
    this.queue.push({ at: this.vt + delayFrames, run });
  }
  deliverDue(): void {
    const due = this.queue.filter((m) => m.at <= this.vt).sort((a, b) => a.at - b.at);
    this.queue = this.queue.filter((m) => m.at > this.vt);
    for (const m of due) m.run();
  }
}

/**
 * Minimal server relay: broadcasts INPUT_BATCH[frame] once BOTH clients
 * have submitted their input for that frame (the deterministic happy
 * path — no packet loss, so the flush timeout never matters here).
 */
class MockRelay {
  private buffers = new Map<number, Map<PlayerId, InputAction[]>>();
  private flushed = new Set<number>();
  constructor(
    private readonly net: Net,
    private readonly latency: number,
    private readonly deliverBatch: (frame: number, inputs: Record<PlayerId, InputAction[]>) => void,
  ) {}

  receive(playerId: PlayerId, frame: number, actions: InputAction[]): void {
    if (this.flushed.has(frame)) return;
    let bucket = this.buffers.get(frame);
    if (!bucket) {
      bucket = new Map();
      this.buffers.set(frame, bucket);
    }
    bucket.set(playerId, actions);
    if (bucket.size === PLAYER_ORDER.length) {
      this.flushed.add(frame);
      const inputs: Record<PlayerId, InputAction[]> = {};
      for (const [id, a] of bucket) inputs[id] = a;
      // Broadcast back to both clients after the down-latency.
      this.net.schedule(this.latency, () => this.deliverBatch(frame, inputs));
    }
  }
}

/** A fake Colyseus room wired to the relay through the virtual net. */
function makeClientRoom(playerId: PlayerId, net: Net, relay: MockRelay, latency: number) {
  const handlers = new Map<string, (raw: unknown) => void>();
  const room = {
    sessionId: playerId,
    onMessage: (type: string, cb: (raw: unknown) => void) => handlers.set(type, cb),
    onLeave: () => {},
    onError: () => {},
    send: (type: string, payload: { frame: number; actions: InputAction[] }) => {
      if (type !== 'INPUT') return; // ignore STATE_HASH / MATCH_ACK / etc.
      net.schedule(latency, () => relay.receive(playerId, payload.frame, payload.actions));
    },
    leave: () => Promise.resolve(),
  } as unknown as Room<unknown>;
  return { room, deliver: (type: string, payload: unknown) => handlers.get(type)?.(payload) };
}

interface Client {
  source: NetworkedMatchSource;
  deliver: (type: string, payload: unknown) => void;
  advanced: number;
  stalls: number;
}

/** Per-player scripted input — deterministic, so both sims agree. */
function scriptedInput(playerId: PlayerId, frame: number): InputAction[] {
  if (playerId === 'p1') return frame % 3 === 0 ? ['MOVE_L'] : [];
  return frame % 4 === 0 ? ['ROT_R'] : [];
}

function runLockstep(opts: { inputDelay: number; latency: number; frames: number }): {
  clients: Client[];
} {
  const net = new Net();
  const clients: Client[] = [];

  const relay = new MockRelay(net, opts.latency, (frame, inputs) => {
    for (const c of clients) c.deliver('INPUT_BATCH', { frame, inputs });
  });

  for (const id of PLAYER_ORDER) {
    const { room, deliver } = makeClientRoom(id, net, relay, opts.latency);
    const source = new NetworkedMatchSource({
      room,
      playerOrder: PLAYER_ORDER,
      myPlayerId: id,
      seed: 12345,
      colorMode: 4,
      dropQueue: DROP_QUEUE,
      inputDelay: opts.inputDelay,
      hashEveryFrames: 1_000_000, // don't emit STATE_HASH in this harness
    });
    clients.push({ source, deliver, advanced: 0, stalls: 0 });
  }

  for (net.vt = 0; net.vt < opts.frames; net.vt++) {
    net.deliverDue();
    for (const c of clients) {
      const f = c.source.match.frame;
      c.source.submitInput(f, scriptedInput(c.source.myPlayerId, f));
      const batch = c.source.getInputBatch(f);
      if (batch) {
        advanceFrame(c.source.match, batch);
        c.advanced++;
      } else {
        c.stalls++;
      }
    }
  }
  return { clients };
}

describe('lockstep under latency', () => {
  it('never stalls and stays in sync when inputDelay covers the round-trip', () => {
    // L=4 one-way ⇒ RTT=8 frames. inputDelay 10 > 8 ⇒ comfortable.
    const { clients } = runLockstep({ inputDelay: 10, latency: 4, frames: 120 });
    const [a, b] = clients;
    expect(a?.stalls).toBe(0);
    expect(b?.stalls).toBe(0);
    // Both advanced every frame and reached the same point.
    expect(a?.source.match.frame).toBe(b?.source.match.frame);
    expect(a?.source.match.frame).toBeGreaterThan(100);
    // Deterministic: identical state on both clients.
    expect(computeHash(a!.source.match)).toBe(computeHash(b!.source.match));
  });

  it('is stall-free right at the boundary inputDelay == round-trip', () => {
    // L=4 ⇒ RTT=8. inputDelay 8 is exactly enough.
    const { clients } = runLockstep({ inputDelay: 8, latency: 4, frames: 120 });
    expect(clients[0]?.stalls).toBe(0);
    expect(clients[1]?.stalls).toBe(0);
    expect(computeHash(clients[0]!.source.match)).toBe(computeHash(clients[1]!.source.match));
  });

  it('DOES stall when inputDelay is smaller than the round-trip (the old bug)', () => {
    // L=6 ⇒ RTT=12. inputDelay 4 (the old default) is far too small.
    const { clients } = runLockstep({ inputDelay: 4, latency: 6, frames: 120 });
    const stalled = (clients[0]?.stalls ?? 0) + (clients[1]?.stalls ?? 0);
    expect(stalled).toBeGreaterThan(0);
  });
});
