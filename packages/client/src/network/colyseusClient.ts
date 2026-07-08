/**
 * Shared Colyseus client and small helpers used by the lobby and match
 * scenes. See D4 §2 and D5 §6.
 *
 * The websocket URL is resolved from env at build time. We accept two
 * sources so a single misconfigured var can't silently break online
 * play (which is exactly what happened once: the deploy set VITE_API_URL
 * but not VITE_SERVER_URL, so the WS fell back to localhost in prod and
 * every match "サーバに接続できませんでした"):
 *
 *   1. `VITE_SERVER_URL` — explicit ws(s):// endpoint, if set.
 *   2. `VITE_API_URL`    — the HTTP API origin; we convert its scheme
 *                          (http→ws, https→wss). The API and the
 *                          Colyseus server share a host, so one var
 *                          configures both.
 *   3. `ws://localhost:2567` — local-dev fallback.
 */

import { type LobbyS2C, type MatchS2C, lobbyS2C, matchS2C } from '@chaindrop/shared/protocol';
import { Client, type Room } from 'colyseus.js';

/**
 * Resolve the websocket endpoint. Vite inlines `import.meta.env.*` as
 * string literals at build time; an unset var is the EMPTY STRING, not
 * nullish, so `||` (not `??`) is required to fall through.
 *
 * Constructing `new Client('')` throws `Invalid URL`, which used to take
 * the whole app down at module load — resolving to a valid fallback URL
 * keeps that from ever happening.
 */
function resolveServerUrl(): string {
  const explicit = (import.meta.env.VITE_SERVER_URL || '').trim();
  if (explicit) return explicit;

  // Derive from the HTTP API origin so the two stay in lock-step.
  const api = (import.meta.env.VITE_API_URL || '').trim();
  if (api) {
    try {
      const u = new URL(api);
      if (u.protocol === 'https:') u.protocol = 'wss:';
      else if (u.protocol === 'http:') u.protocol = 'ws:';
      // Colyseus wants an origin, not a trailing slash.
      return u.toString().replace(/\/$/, '');
    } catch {
      /* fall through to localhost */
    }
  }
  return 'ws://localhost:2567';
}

const SERVER_URL = resolveServerUrl();

let _colyseus: Client | null = null;
function getColyseus(): Client {
  if (!_colyseus) _colyseus = new Client(SERVER_URL);
  return _colyseus;
}

/**
 * Lazy proxy: constructing the underlying Client throws if the URL is
 * malformed. Routing every access through `getColyseus()` keeps the
 * failure isolated to the moment a scene actually tries to connect,
 * rather than blowing up React's initial render.
 */
type AnyFn = (...args: unknown[]) => unknown;

export const colyseus = new Proxy({} as Client, {
  get(_t, prop) {
    const real = getColyseus() as unknown as Record<string | symbol, unknown>;
    const value = real[prop];
    return typeof value === 'function' ? (value as AnyFn).bind(real) : value;
  },
});

export type LobbyRoomHandle = Room<unknown>;
export type MatchRoomHandle = Room<unknown>;

/**
 * Subscribe to every known message type on a room and forward parsed,
 * validated payloads to a single handler. Anything that fails to parse
 * is logged and dropped — never thrown — so a buggy server can't take
 * down the client scene.
 */
export function onLobbyMessage(room: LobbyRoomHandle, handler: (msg: LobbyS2C) => void): void {
  const types: LobbyS2C['t'][] = [
    'LOBBY_JOINED',
    'LOBBY_STATE',
    'ROOM_CREATED',
    'JOIN_ROOM_OK',
    'JOIN_ROOM_REJECTED',
    'QUICK_MATCH_FOUND',
    'ERROR',
  ];
  for (const t of types) {
    room.onMessage(t, (raw: unknown) => {
      const parsed = lobbyS2C.safeParse({
        t,
        ...(typeof raw === 'object' && raw !== null ? raw : {}),
      });
      if (!parsed.success) {
        console.warn('[lobby] dropped malformed', t, parsed.error.issues);
        return;
      }
      handler(parsed.data);
    });
  }
}

export interface MatchMessageOptions {
  /**
   * Called when a server message fails validation and is dropped. A
   * burst of these usually means the deployed server and client speak
   * different protocol versions (e.g. mid-deploy), which otherwise
   * looks like a silent hang — the scene can surface a "再読み込みして
   * ください" hint instead.
   */
  onDropped?: (type: MatchS2C['t']) => void;
}

export function onMatchMessage(
  room: MatchRoomHandle,
  handler: (msg: MatchS2C) => void,
  options: MatchMessageOptions = {},
): void {
  const types: MatchS2C['t'][] = [
    'MATCH_ROOM_STATE',
    'COUNTDOWN_START',
    'COUNTDOWN_CANCEL',
    'MATCH_START',
    'MATCH_BEGIN',
    'INPUT_BATCH',
    'PLAYER_ELIMINATED',
    'PLAYER_DISCONNECTED',
    'PLAYER_RECONNECTED',
    'MATCH_END',
    'DESYNC_DETECTED',
    'PONG',
    'ERROR',
  ];
  for (const t of types) {
    room.onMessage(t, (raw: unknown) => {
      const parsed = matchS2C.safeParse({
        t,
        ...(typeof raw === 'object' && raw !== null ? raw : {}),
      });
      if (!parsed.success) {
        console.warn('[match] dropped malformed', t, parsed.error.issues);
        options.onDropped?.(t);
        return;
      }
      handler(parsed.data);
    });
  }
}
