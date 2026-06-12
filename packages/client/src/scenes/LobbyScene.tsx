/**
 * LobbyScene — オンラインルーム作成 / オンライン参加 のハブ.
 *
 * Phase A changes (per playtest):
 *   - Nickname input field removed; we read the player name straight
 *     from the persisted account record (guest names auto-generated
 *     by `state/account.ts`).
 *   - The lone 接続 button is split into オンラインルーム作成 /
 *     オンライン参加 — both auto-connect to the lobby when clicked
 *     and reveal the corresponding panel.
 *   - Each room in the list has a 参加 button next to it; password-
 *     less rooms join directly on click. Password rooms will get a
 *     prompt in Phase B; for now we surface a banner so the player
 *     knows the action isn't ignored.
 */

import type { Capacity, ColorMode, RoomSummary } from '@chaindrop/shared/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type LobbyRoomHandle, colyseus, onLobbyMessage } from '../network/colyseusClient';
import { loadAccount } from '../state/account';

interface Props {
  /** Called once we successfully obtained a match room id. */
  onJoinMatch: (roomId: string, nickname: string) => void;
  onBack: () => void;
}

type Pane = 'menu' | 'create' | 'join';

export function LobbyScene({ onJoinMatch, onBack }: Props) {
  const account = useMemo(() => loadAccount(), []);
  const nickname = account.playerName;

  const [pane, setPane] = useState<Pane>('menu');
  const [connected, setConnected] = useState(false);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [capacity, setCapacity] = useState<Capacity>(2);
  const [colorMode, setColorMode] = useState<ColorMode>(4);
  const [isPrivate, setIsPrivate] = useState(false);
  const roomRef = useRef<LobbyRoomHandle | null>(null);
  const handedOff = useRef(false);
  /** Synchronous guard so two fast clicks can't both open a lobby room. */
  const connectingRef = useRef(false);

  const cleanup = useCallback(async () => {
    const room = roomRef.current;
    roomRef.current = null;
    if (room && !handedOff.current) {
      try {
        await room.leave();
      } catch {
        /* ignore */
      }
    }
  }, []);

  useEffect(() => {
    return () => {
      void cleanup();
    };
  }, [cleanup]);

  const connect = useCallback(async (): Promise<LobbyRoomHandle | null> => {
    // Synchronous re-entry guard: `roomRef.current` is only set AFTER
    // the await resolves, so two fast clicks could both start a
    // joinOrCreate and leak a room. `connecting` latches immediately.
    if (roomRef.current) return roomRef.current;
    if (connectingRef.current) return null;
    connectingRef.current = true;
    setError(null);
    setBusy(true);
    try {
      const room = (await colyseus.joinOrCreate('lobby', {})) as LobbyRoomHandle;
      roomRef.current = room;
      // Detect the socket dropping (server redeploy, WiFi loss). Without
      // this the last LOBBY_STATE stays frozen on screen with the
      // create/join buttons firing into a dead socket forever.
      room.onLeave(() => {
        if (handedOff.current) return;
        roomRef.current = null;
        setConnected(false);
        setBusy(false);
        setRooms([]);
        setError('サーバとの接続が切れました。再試行してください');
      });
      room.onError(() => {
        setError('通信エラーが発生しました。再試行してください');
        setBusy(false);
      });
      onLobbyMessage(room, (msg) => {
        switch (msg.t) {
          case 'LOBBY_JOINED':
            setConnected(true);
            break;
          case 'LOBBY_STATE':
            setRooms(msg.rooms);
            break;
          case 'ROOM_CREATED':
            // Immediately attempt to join the room we just made so
            // the host lands in the waiting room.
            void joinMatchId(msg.roomId);
            break;
          case 'JOIN_ROOM_OK':
            // Latch the handoff so a duplicate JOIN_ROOM_OK can't fire
            // onJoinMatch twice (which would double-join the match room).
            if (handedOff.current) break;
            handedOff.current = true;
            onJoinMatch(msg.matchRoomUrl, nickname);
            break;
          case 'JOIN_ROOM_REJECTED':
            setError(reasonLabel(msg.reason));
            break;
          case 'ERROR':
            setError(`${msg.code}: ${msg.message}`);
            break;
        }
      });
      room.send('JOIN_LOBBY', { nickname });
      return room;
    } catch (err) {
      console.error(err);
      setError('サーバに接続できませんでした。再試行してください');
      return null;
    } finally {
      connectingRef.current = false;
      setBusy(false);
    }
  }, [nickname, onJoinMatch]);

  const openCreate = useCallback(async () => {
    setPane('create');
    await connect();
  }, [connect]);

  const openJoin = useCallback(async () => {
    setPane('join');
    await connect();
  }, [connect]);

  const createRoom = useCallback(() => {
    const room = roomRef.current;
    if (!room) return;
    setBusy(true);
    room.send('CREATE_ROOM', {
      capacity,
      colorMode,
      isPrivate,
    });
  }, [capacity, colorMode, isPrivate]);

  const joinMatchId = useCallback((roomId: string) => {
    const room = roomRef.current;
    if (!room) return;
    room.send('JOIN_ROOM', { roomId });
  }, []);

  const handleEnter = useCallback(
    (r: RoomSummary) => {
      if (r.isPrivate) {
        // Password-room join lands in Phase B; for now surface the
        // limitation rather than silently failing.
        setError('パスワード付きルームの参加は近日対応予定です');
        return;
      }
      joinMatchId(r.roomId);
    },
    [joinMatchId],
  );

  const retry = useCallback(() => {
    setError(null);
    void connect();
  }, [connect]);

  return (
    <div className="scene lobby-scene">
      <div className="lobby-header">
        <h2>ロビー</h2>
        <button
          type="button"
          className="lobby-back"
          onClick={() => {
            void cleanup();
            onBack();
          }}
        >
          戻る
        </button>
      </div>

      <p className="lobby-identity">
        <span>プレイヤー名:</span> <strong>{nickname}</strong>
        {account.guest && <span className="lobby-identity-guest">（ゲスト）</span>}
      </p>

      {pane === 'menu' && (
        <div className="lobby-menu snes-window">
          <button
            type="button"
            className="title-menu-btn primary"
            disabled={busy}
            onClick={() => void openCreate()}
          >
            オンラインルーム作成
          </button>
          <button
            type="button"
            className="title-menu-btn"
            disabled={busy}
            onClick={() => void openJoin()}
          >
            オンライン参加
          </button>
        </div>
      )}

      {pane === 'create' && (
        <div className="lobby-create snes-window">
          <h3 className="lobby-section-title">ルーム作成</h3>
          <label className="lobby-field">
            <span>人数</span>
            <select
              value={capacity}
              onChange={(e) => setCapacity(Number(e.target.value) as Capacity)}
            >
              <option value={2}>2 人</option>
              <option value={3}>3 人</option>
              <option value={4}>4 人</option>
            </select>
          </label>
          <label className="lobby-field">
            <span>色数</span>
            <select
              value={colorMode}
              onChange={(e) => setColorMode(Number(e.target.value) as ColorMode)}
            >
              <option value={4}>4 色</option>
              <option value={5}>5 色</option>
            </select>
          </label>
          <label className="lobby-field lobby-field-inline">
            <input
              type="checkbox"
              checked={isPrivate}
              onChange={(e) => setIsPrivate(e.target.checked)}
            />
            <span>パスワード付きルーム（近日対応）</span>
          </label>
          <div className="lobby-actions">
            <button type="button" className="title-menu-btn" onClick={() => setPane('menu')}>
              戻る
            </button>
            <button
              type="button"
              className="title-menu-btn primary"
              disabled={busy || !connected}
              onClick={createRoom}
            >
              作成
            </button>
          </div>
          {!connected && <p className="lobby-info">サーバに接続中…</p>}
        </div>
      )}

      {pane === 'join' && (
        <div className="lobby-rooms snes-window">
          <h3 className="lobby-section-title">ルーム一覧</h3>
          <div className="lobby-rooms-toolbar">
            <button type="button" className="title-menu-btn" onClick={() => setPane('menu')}>
              戻る
            </button>
          </div>
          {!connected ? (
            <p className="lobby-info">サーバに接続中…</p>
          ) : rooms.length === 0 ? (
            <p className="lobby-empty">ルームはまだありません</p>
          ) : (
            <ul>
              {rooms.map((r) => (
                <li key={r.roomId}>
                  <span className="lobby-room-name">{r.name || r.roomId}</span>
                  <span className="lobby-room-meta">
                    {r.players}/{r.capacity} · {r.colorMode}色 · {r.isPrivate ? '🔒' : 'OPEN'} ·{' '}
                    {r.status}
                  </span>
                  <button
                    type="button"
                    disabled={busy || r.status !== 'lobby' || r.players >= r.capacity}
                    onClick={() => handleEnter(r)}
                  >
                    参加
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error && (
        <div className="lobby-error-row">
          <p className="lobby-error">{error}</p>
          <button type="button" className="lobby-retry" disabled={busy} onClick={retry}>
            再試行
          </button>
        </div>
      )}
    </div>
  );
}

function reasonLabel(reason: 'FULL' | 'NOT_FOUND' | 'MATCH_IN_PROGRESS' | 'BAD_CODE'): string {
  switch (reason) {
    case 'FULL':
      return 'ルームは満員です';
    case 'NOT_FOUND':
      return 'ルームが見つかりません';
    case 'MATCH_IN_PROGRESS':
      return 'このルームはすでに対戦中です';
    case 'BAD_CODE':
      return 'パスワードが違います';
  }
}
