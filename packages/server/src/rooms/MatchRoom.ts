/**
 * MatchRoom — one Colyseus room per match instance.
 *
 * M3a scope: join / leave, READY toggle, countdown, MATCH_START with
 * seed + drop queue, transition to `running`. INPUT forwarding,
 * STATE_HASH desync detection, and reconnect support are M3b/M3c.
 *
 * See D6 §6 — and the note in `state.ts` for why this file maintains
 * room state in plain JS instead of through Colyseus's schema sync.
 * Every shape that used to live on `this.state` (players + config +
 * status) now lives on plain instance fields, and clients learn about
 * changes through manual `broadcast('MATCH_ROOM_STATE', ...)` of the
 * zod-typed message we already defined for the protocol.
 */

import { generateDropQueue } from '@chaindrop/shared';
import type { MatchPlayer, RoomSummary } from '@chaindrop/shared/protocol';
import { matchC2S } from '@chaindrop/shared/protocol';
import { type Client, Room } from '@colyseus/core';
import { HashChecker } from '../match/HashChecker';
import { InputRelay } from '../match/InputRelay';
import { lobbyBus, matchRooms } from '../util/lobbyBus';
import { logger } from '../util/logger';
import { sanitizeNickname } from '../util/sanitize';
import { MatchRoomState } from './state';

export interface MatchCreateOptions {
  roomId: string;
  capacity: 2 | 3 | 4;
  colorMode: 4 | 5;
  isPrivate: boolean;
  joinCode?: string;
  name: string;
}

export interface MatchJoinOptions {
  joinCode?: string;
  nickname: string;
  characterId: string;
}

const COUNTDOWN_FRAMES = 180;
const COUNTDOWN_MS = 3_000; // 3 seconds, matches D2 §1.4 / D4 §3.2
const DROP_QUEUE_LENGTH = 1024;
// Slight latency buffer so every client has the MATCH_START message in
// hand before they're asked to start ticking. Tuned to comfortably
// cover an inter-region websocket round-trip.
const MATCH_BEGIN_PADDING_MS = 200;

type Status = 'lobby' | 'countdown' | 'running' | 'finished';

export class MatchRoom extends Room<MatchRoomState> {
  override maxClients = 4;
  override autoDispose = false;

  // ---- room metadata ----
  private roomIdValue = '';
  private capacityValue: 2 | 3 | 4 = 2;
  private colorModeValue: 4 | 5 = 4;
  private isPrivateValue = false;
  private joinCode: string | undefined;
  private name = '';

  // ---- run-time state (replaces what used to live on `this.state`) ----
  private status: Status = 'lobby';
  private players = new Map<string, MatchPlayer>();

  // ---- countdown / match state ----
  private countdownHandle: ReturnType<Room['clock']['setTimeout']> | undefined;
  private matchSeed = 0;
  private dropQueue: [string, string][] = [];
  private playerOrder: string[] = [];
  private inputRelay: InputRelay | undefined;
  private hashChecker: HashChecker | undefined;
  /** Latches once a winner has been declared so MATCH_END fires once. */
  private matchEnded = false;

  override onCreate(opts: MatchCreateOptions): void {
    // Empty Schema state — the room still needs SOMETHING to satisfy
    // Colyseus's room/serializer contract, but nothing on it is
    // decorated, so the encoder never has to touch metadata.
    this.setState(new MatchRoomState());

    this.capacityValue = opts.capacity;
    this.colorModeValue = opts.colorMode;
    this.isPrivateValue = opts.isPrivate;
    this.maxClients = opts.capacity;
    this.roomIdValue = opts.roomId;
    this.joinCode = opts.joinCode;
    this.name = opts.name || `Match ${opts.roomId}`;
    // The roomId Colyseus assigns is random; we override it so the
    // lobby's roomId === the client-visible identifier.
    this.roomId = opts.roomId;

    this.onMessage('*', (client, type, message) => this.handle(client, type, message));

    matchRooms.set(this.roomIdValue, this.summary());
    lobbyBus.emit('room:created', this.summary());
    logger.info({ roomId: this.roomIdValue, capacity: opts.capacity }, 'MatchRoom created');
  }

  override onJoin(client: Client, opts: MatchJoinOptions): void {
    if (this.status !== 'lobby') {
      client.leave(4001, 'MATCH_IN_PROGRESS');
      return;
    }
    if (this.joinCode && opts.joinCode !== this.joinCode) {
      client.leave(4002, 'BAD_CODE');
      return;
    }

    const slot = this.assignSlot();
    const nickname = sanitizeNickname(opts.nickname);
    const player: MatchPlayer = {
      playerId: client.sessionId,
      nickname,
      characterId: opts.characterId,
      slotIndex: slot,
      ready: false,
      connected: true,
    };
    this.players.set(client.sessionId, player);

    this.broadcastRoomState();
    this.publishSummary();
    logger.info({ roomId: this.roomIdValue, sessionId: client.sessionId, slot }, 'match join');
  }

  override onLeave(client: Client, _consented: boolean): void {
    const p = this.players.get(client.sessionId);
    if (!p) return;
    // M3b will wrap `running` leaves with `allowReconnection` and a
    // disconnect timer — for now we just remove the player.
    this.players.delete(client.sessionId);

    if (this.status === 'countdown') {
      // Someone bailed mid-countdown — abort and rewind to lobby.
      this.cancelCountdown('PLAYER_LEFT');
    }

    // A leave DURING a running match is a forfeit: whoever is left
    // standing wins. Without this the survivor's client froze on the
    // last frame forever (the opponent's input batches simply stopped
    // arriving and nothing declared an end). 1v1 is the only supported
    // mode today, so "exactly one left" => that player wins; if the
    // room empties entirely the match is abandoned with no winner.
    if (this.status === 'running') {
      const remaining = Array.from(this.players.values());
      if (remaining.length === 1) {
        this.declareWinner(remaining[0]?.playerId ?? null);
        return;
      }
      if (remaining.length === 0) {
        this.declareWinner(null);
        this.status = 'lobby';
        this.publishRemoval();
        this.disconnect();
        return;
      }
    }

    if (this.players.size === 0) {
      this.status = 'lobby';
      this.publishRemoval();
      this.disconnect();
      return;
    }
    this.broadcastRoomState();
    this.publishSummary();
  }

  override onDispose(): void {
    this.inputRelay?.dispose();
    this.hashChecker?.dispose();
    this.publishRemoval();
    logger.info({ roomId: this.roomIdValue }, 'MatchRoom disposed');
  }

  // ----------------------------------------------------------------

  /** Write the latest summary into the shared registry and fan it out
   *  to every active LobbyRoom. Always pair the two — the registry is
   *  what the next JOIN_LOBBY snapshot reads from, the bus is what the
   *  live LOBBY_STATE broadcasts react to. */
  private publishSummary(): void {
    const summary = this.summary();
    matchRooms.set(this.roomIdValue, summary);
    lobbyBus.emit('room:update', summary);
  }

  private publishRemoval(): void {
    matchRooms.delete(this.roomIdValue);
    lobbyBus.emit('room:removed', this.roomIdValue);
  }

  private broadcastRoomState(): void {
    this.broadcast('MATCH_ROOM_STATE', {
      players: Array.from(this.players.values()),
      config: {
        capacity: this.capacityValue,
        colorMode: this.colorModeValue,
        isPrivate: this.isPrivateValue,
      },
      status: this.status,
    });
  }

  private handle(client: Client, type: string | number, raw: unknown): void {
    const parsed = matchC2S.safeParse({
      t: type,
      ...(typeof raw === 'object' && raw !== null ? raw : {}),
    });
    if (!parsed.success) {
      client.send('ERROR', {
        code: 'BAD_MESSAGE',
        message: `unknown or malformed ${String(type)}`,
      });
      return;
    }
    const msg = parsed.data;
    switch (msg.t) {
      case 'MATCH_JOIN':
        // The actual join happens in `onJoin`; this is a redundant ack
        // path that allows clients to update their nickname/character
        // mid-lobby. We accept but do nothing yet.
        return;
      case 'SET_READY':
        this.onSetReady(client, msg.ready);
        return;
      case 'MATCH_ACK':
        // Could be used to gate MATCH_BEGIN — currently the server
        // fires MATCH_BEGIN on a fixed timer, so this is a no-op.
        return;
      case 'INPUT':
        this.inputRelay?.submit(client.sessionId, msg.frame, msg.actions);
        return;
      case 'STATE_HASH':
        this.hashChecker?.submit(client.sessionId, msg.frame, msg.hash);
        return;
      case 'PING':
        client.send('PONG', { clientMs: msg.clientMs, serverMs: Date.now() });
        return;
      case 'LEAVE_MATCH':
        client.leave(1000, 'consented');
        return;
    }
  }

  private onSetReady(client: Client, ready: boolean): void {
    const p = this.players.get(client.sessionId);
    if (!p) return;
    p.ready = ready;
    // Cancel the countdown if anyone un-readies while it is running.
    if (this.status === 'countdown' && !ready) {
      this.cancelCountdown('PLAYER_UNREADIED');
      this.broadcastRoomState();
      return;
    }
    this.broadcastRoomState();
    this.checkAllReady();
  }

  private checkAllReady(): void {
    if (this.status !== 'lobby') return;
    const players = Array.from(this.players.values());
    const full = players.length === this.capacityValue;
    const allReady = players.every((p) => p.ready && p.connected);
    if (full && allReady) {
      this.startCountdown();
    }
  }

  private startCountdown(): void {
    this.status = 'countdown';
    this.broadcastRoomState();
    this.publishSummary();
    this.broadcast('COUNTDOWN_START', {
      durationFrames: COUNTDOWN_FRAMES,
      serverStartMs: Date.now(),
    });
    this.countdownHandle = this.clock.setTimeout(() => this.beginMatch(), COUNTDOWN_MS);
    logger.info({ roomId: this.roomIdValue }, 'countdown started');
  }

  private cancelCountdown(reason: string): void {
    this.countdownHandle?.clear();
    this.countdownHandle = undefined;
    this.status = 'lobby';
    this.broadcast('COUNTDOWN_CANCEL', { reason });
    this.broadcastRoomState();
    this.publishSummary();
    logger.info({ roomId: this.roomIdValue, reason }, 'countdown cancelled');
  }

  private beginMatch(): void {
    // Seed is a non-zero 32-bit integer so the xorshift32 RNG in shared
    // never gets stuck on zero. Drop queue is generated once on the
    // server and pushed to every client so all sims are deterministic.
    this.matchSeed = (Math.floor(Math.random() * 0xfffffffe) + 1) | 0;
    this.dropQueue = generateDropQueue(
      this.matchSeed,
      DROP_QUEUE_LENGTH,
      this.colorModeValue,
    ) as unknown as [string, string][];

    this.playerOrder = Array.from(this.players.values())
      .sort((a, b) => a.slotIndex - b.slotIndex)
      .map((p) => p.playerId);

    this.inputRelay = new InputRelay({
      playerOrder: this.playerOrder,
      onBatchReady: (frame, inputs) => this.broadcast('INPUT_BATCH', { frame, inputs }),
      onPlayerTimeout: (playerId) => this.onPlayerTimeout(playerId),
    });
    this.hashChecker = new HashChecker({
      playerOrder: this.playerOrder,
      onMismatch: (frame, hashes) => {
        logger.warn({ roomId: this.roomIdValue, frame, hashes }, 'desync detected');
        this.broadcast('DESYNC_DETECTED', { frame, hashes });
      },
    });

    this.status = 'running';
    this.broadcastRoomState();
    this.publishSummary();

    this.broadcast('MATCH_START', {
      seed: this.matchSeed,
      dropQueue: this.dropQueue,
      playerOrder: this.playerOrder,
      startFrameMs: Date.now() + MATCH_BEGIN_PADDING_MS,
    });

    // MATCH_BEGIN is the simulator-tick trigger; we send it once the
    // pad has elapsed so every client has had time to receive
    // MATCH_START and prime its scheduler.
    this.clock.setTimeout(() => {
      this.broadcast('MATCH_BEGIN', {});
    }, MATCH_BEGIN_PADDING_MS);

    logger.info({ roomId: this.roomIdValue, seed: this.matchSeed }, 'match started');
  }

  /**
   * A player missed `missThreshold` consecutive input frames — treat
   * them as disconnected and award the match to whoever is left. The
   * PLAYER_DISCONNECTED broadcast still goes out (banner fodder), but
   * we now also resolve the match so the survivor isn't stuck.
   */
  private onPlayerTimeout(playerId: string): void {
    this.broadcast('PLAYER_DISCONNECTED', { playerId, atFrame: 0 });
    if (this.status !== 'running' || this.matchEnded) return;
    const survivors = this.playerOrder.filter((id) => id !== playerId);
    // 1v1: exactly one survivor wins. >2 players is future scope — only
    // resolve when the timeout leaves a single standing player.
    if (survivors.length === 1) {
      this.declareWinner(survivors[0] ?? null);
    }
  }

  /**
   * Authoritatively end a running match. Broadcasts MATCH_END (clients
   * fall through to the result screen) and tears down the lockstep
   * machinery so no further batches/desyncs fire. Idempotent.
   */
  private declareWinner(winnerId: string | null): void {
    if (this.matchEnded) return;
    this.matchEnded = true;
    this.status = 'finished';
    this.broadcast('MATCH_END', { winnerId });
    this.inputRelay?.dispose();
    this.inputRelay = undefined;
    this.hashChecker?.dispose();
    this.hashChecker = undefined;
    this.publishSummary();
    logger.info({ roomId: this.roomIdValue, winnerId }, 'match ended (authoritative)');
  }

  private assignSlot(): number {
    const used = new Set<number>();
    for (const p of this.players.values()) used.add(p.slotIndex);
    for (let i = 0; i < this.capacityValue; i++) {
      if (!used.has(i)) return i;
    }
    return this.players.size; // fallback, shouldn't normally hit
  }

  private summary(): RoomSummary {
    return {
      roomId: this.roomIdValue,
      name: this.name,
      capacity: this.capacityValue,
      colorMode: this.colorModeValue,
      players: this.players.size,
      isPrivate: this.isPrivateValue,
      status: this.status === 'finished' ? 'lobby' : this.status,
    };
  }
}
