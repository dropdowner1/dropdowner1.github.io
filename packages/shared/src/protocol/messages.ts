/**
 * C↔S message schemas — zod-validated runtime types for Lobby and
 * Match rooms. See D4 §2.
 *
 * Each message has a `t` discriminator that maps 1:1 to the Colyseus
 * message name used over the wire. The server validates every incoming
 * message against the corresponding C2S schema before acting on it; the
 * client validates every incoming S2C message before dispatching to
 * scene state. Anything that doesn't parse is dropped and logged — the
 * protocol version (`PROTOCOL_VERSION`) is bumped if the schemas change
 * shape in a non-backwards-compatible way.
 */

import { z } from 'zod';

// ---------- Primitives ----------

const playerId = z.string();
const roomId = z.string();
const frame = z.number().int().nonnegative();

const colorMode = z.union([z.literal(4), z.literal(5)]);
const capacity = z.union([z.literal(2), z.literal(3), z.literal(4)]);
const puyoColor = z.enum(['R', 'G', 'B', 'Y', 'P']);
const inputAction = z.enum(['MOVE_L', 'MOVE_R', 'ROT_L', 'ROT_R', 'SOFT_START', 'SOFT_END']);

const roomStatus = z.enum(['lobby', 'countdown', 'running', 'finished']);

// Nicknames are surfaced in the lobby UI and the result screen, so keep
// them short and printable. The server further sanitises before storing.
const nickname = z.string().min(1).max(20);

// ---------- Lobby C→S ----------

export const lobbyC2S = z.discriminatedUnion('t', [
  z.object({ t: z.literal('JOIN_LOBBY'), nickname }),
  z.object({
    t: z.literal('CREATE_ROOM'),
    capacity,
    colorMode,
    isPrivate: z.boolean(),
    name: z.string().max(40).optional(),
  }),
  z.object({ t: z.literal('JOIN_ROOM'), roomId, joinCode: z.string().optional() }),
  z.object({ t: z.literal('QUICK_MATCH'), capacity, colorMode }),
  z.object({ t: z.literal('CANCEL_QUICK_MATCH') }),
  z.object({ t: z.literal('LEAVE_LOBBY') }),
]);
export type LobbyC2S = z.infer<typeof lobbyC2S>;

// ---------- Lobby S→C ----------

const roomSummary = z.object({
  roomId,
  name: z.string(),
  capacity,
  colorMode,
  players: z.number().int().nonnegative(),
  isPrivate: z.boolean(),
  status: roomStatus,
});
export type RoomSummary = z.infer<typeof roomSummary>;

export const lobbyS2C = z.discriminatedUnion('t', [
  z.object({ t: z.literal('LOBBY_JOINED'), playerId }),
  z.object({ t: z.literal('LOBBY_STATE'), rooms: z.array(roomSummary) }),
  z.object({ t: z.literal('ROOM_CREATED'), roomId, joinCode: z.string().optional() }),
  z.object({ t: z.literal('JOIN_ROOM_OK'), roomId, matchRoomUrl: z.string() }),
  z.object({
    t: z.literal('JOIN_ROOM_REJECTED'),
    reason: z.enum(['FULL', 'NOT_FOUND', 'MATCH_IN_PROGRESS', 'BAD_CODE']),
  }),
  z.object({ t: z.literal('QUICK_MATCH_FOUND'), roomId, matchRoomUrl: z.string() }),
  z.object({ t: z.literal('ERROR'), code: z.string(), message: z.string() }),
]);
export type LobbyS2C = z.infer<typeof lobbyS2C>;

// ---------- Match C→S ----------

export const matchC2S = z.discriminatedUnion('t', [
  z.object({ t: z.literal('MATCH_JOIN'), nickname, characterId: z.string() }),
  z.object({ t: z.literal('SET_READY'), ready: z.boolean() }),
  z.object({ t: z.literal('MATCH_ACK') }),
  z.object({ t: z.literal('INPUT'), frame, actions: z.array(inputAction) }),
  z.object({ t: z.literal('STATE_HASH'), frame, hash: z.string() }),
  z.object({ t: z.literal('PING'), clientMs: z.number() }),
  z.object({ t: z.literal('LEAVE_MATCH') }),
]);
export type MatchC2S = z.infer<typeof matchC2S>;

// ---------- Match S→C ----------

const matchPlayer = z.object({
  playerId,
  nickname: z.string(),
  characterId: z.string(),
  slotIndex: z.number().int().nonnegative(),
  ready: z.boolean(),
  connected: z.boolean(),
});
export type MatchPlayer = z.infer<typeof matchPlayer>;

const matchConfig = z.object({
  capacity,
  colorMode,
  isPrivate: z.boolean(),
});
export type MatchConfig = z.infer<typeof matchConfig>;

const dropPair = z.tuple([puyoColor, puyoColor]);

export const matchS2C = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('MATCH_ROOM_STATE'),
    players: z.array(matchPlayer),
    config: matchConfig,
    status: roomStatus,
  }),
  z.object({
    t: z.literal('COUNTDOWN_START'),
    durationFrames: z.literal(180),
    serverStartMs: z.number(),
  }),
  z.object({ t: z.literal('COUNTDOWN_CANCEL'), reason: z.string() }),
  z.object({
    t: z.literal('MATCH_START'),
    seed: z.number(),
    dropQueue: z.array(dropPair),
    playerOrder: z.array(playerId),
    startFrameMs: z.number(),
  }),
  z.object({ t: z.literal('MATCH_BEGIN') }),
  z.object({
    t: z.literal('INPUT_BATCH'),
    frame,
    inputs: z.record(playerId, z.array(inputAction)),
  }),
  z.object({ t: z.literal('PLAYER_ELIMINATED'), playerId, atFrame: frame }),
  z.object({ t: z.literal('PLAYER_DISCONNECTED'), playerId, atFrame: frame }),
  z.object({ t: z.literal('PLAYER_RECONNECTED'), playerId, atFrame: frame }),
  z.object({
    t: z.literal('MATCH_END'),
    winnerId: z.union([playerId, z.null()]),
  }),
  z.object({
    t: z.literal('DESYNC_DETECTED'),
    frame,
    hashes: z.record(playerId, z.string()),
  }),
  z.object({ t: z.literal('PONG'), clientMs: z.number(), serverMs: z.number() }),
  z.object({ t: z.literal('ERROR'), code: z.string(), message: z.string() }),
]);
export type MatchS2C = z.infer<typeof matchS2C>;
