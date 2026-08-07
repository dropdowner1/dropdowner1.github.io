/**
 * NetworkedMatchScene — 1v1 lockstep match driven by Colyseus.
 *
 * Cousin of `MatchScene`, but the simulator is fed by a
 * `NetworkedMatchSource` that exchanges INPUT / INPUT_BATCH /
 * STATE_HASH with the server (see D4 §4).
 *
 * Two `FieldRenderer` + `NextRenderer` pairs are mounted side-by-side
 * — the local player on the left, the opponent on the right — by
 * translating each renderer's Pixi container into its half of the
 * 1280×720 internal coord space.
 */

import type { MatchState, PlayerId, PuyoColor } from '@chaindrop/shared';
import type { Room } from 'colyseus.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createMatchAudio } from '../audio/MatchAudio';
import { InputSystem } from '../input/InputSystem';
import { BackgroundRenderer } from '../renderer/BackgroundRenderer';
import { FieldRenderer } from '../renderer/FieldRenderer';
import { NextRenderer } from '../renderer/NextRenderer';
import { PixiApp } from '../renderer/PixiApp';
import { PuyoSheet } from '../renderer/PuyoTexture';
import { FIELD_ORIGIN_X } from '../renderer/layout';
import { FrameScheduler } from '../simulator/FrameScheduler';
import type { MatchEndReason } from '../simulator/MatchSource';
import { NetworkedMatchSource } from '../simulator/NetworkedMatchSource';

/**
 * How long the sim may sit stalled on a missing network batch before
 * we warn the player, and before we give up and treat it as a lost
 * connection. The server force-flushes partial frames every 200ms, so
 * a multi-second stall means our own socket is the problem.
 */
const STALL_WARN_MS = 2_500;
const STALL_LOST_MS = 10_000;

/**
 * Where each player's field lands on the 1280-wide internal canvas.
 * The renderer instances all draw at FIELD_ORIGIN_X internally, so the
 * `containerOffset` here is the horizontal shift applied to their
 * parent Container to slide each into its own half of the screen.
 */
const LEFT_FIELD_X = 200;
const RIGHT_FIELD_X = 840;
const LEFT_OFFSET = LEFT_FIELD_X - FIELD_ORIGIN_X;
const RIGHT_OFFSET = RIGHT_FIELD_X - FIELD_ORIGIN_X;

const ASSET_BASE = import.meta.env.BASE_URL;

export interface NetworkedMatchResult {
  winnerId: PlayerId | null;
  myPlayerId: PlayerId;
  frame: number;
  score: number;
  maxChain: number;
  /** `desync` matches must not be recorded in win/loss stats. */
  reason: MatchEndReason;
}

interface PlayerHud {
  nickname: string;
  score: number;
  chain: number;
  maxChain: number;
  pendingOjama: number;
}

interface Props {
  room: Room<unknown>;
  myPlayerId: PlayerId;
  playerOrder: readonly PlayerId[];
  nicknamesByPlayerId: Record<PlayerId, string>;
  seed: number;
  colorMode: 4 | 5;
  dropQueue: readonly (readonly [PuyoColor, PuyoColor])[];
  /** Bumped by App when the browser Back button is pressed — opens the
   *  leave-confirm rather than abandoning the match. */
  backSignal?: number;
  onEnd: (result: NetworkedMatchResult) => void;
  onQuit: () => void;
}

export function NetworkedMatchScene({
  room,
  myPlayerId,
  playerOrder,
  nicknamesByPlayerId,
  seed,
  backSignal,
  colorMode,
  dropQueue,
  onEnd,
  onQuit,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [huds, setHuds] = useState<Record<PlayerId, PlayerHud>>(() => {
    const out: Record<PlayerId, PlayerHud> = {};
    for (const id of playerOrder) {
      out[id] = {
        nickname: nicknamesByPlayerId[id] ?? id,
        score: 0,
        chain: 0,
        maxChain: 0,
        pendingOjama: 0,
      };
    }
    return out;
  });
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  /**
   * Esc and the 退出 button open a confirmation overlay rather than
   * tearing the match down immediately. The original "Esc = instant
   * forfeit" mapping conflicted with the solo Esc=pause muscle memory
   * and caused accidental losses.
   */
  const [confirmLeave, setConfirmLeave] = useState(false);
  const confirmLeaveRef = useRef(false);
  confirmLeaveRef.current = confirmLeave;

  // Browser Back (relayed by App via backSignal) opens the same
  // leave-confirm as Esc / the 退出 button, so it can't abandon a live
  // match. Skip the initial render (no real Back press yet).
  const prevBackSignal = useRef(backSignal);
  useEffect(() => {
    if (backSignal === undefined || backSignal === prevBackSignal.current) return;
    prevBackSignal.current = backSignal;
    setConfirmLeave(true);
  }, [backSignal]);

  const onEndRef = useRef(onEnd);
  const onQuitRef = useRef(onQuit);
  onEndRef.current = onEnd;
  onQuitRef.current = onQuit;

  /** Forfeit-and-exit. The effect wires this to the live source so the
   *  room is actually left (server awards the opponent the win) before
   *  we route back to the title. Set inside the effect. */
  const leaveAndQuitRef = useRef<() => void>(() => onQuitRef.current());

  // Stable identity of who's left vs right, computed once so it
  // doesn't churn between renders.
  const myIndex = Math.max(0, playerOrder.indexOf(myPlayerId));
  const opponentIndex = myIndex === 0 ? 1 : 0;
  const opponentId = playerOrder[opponentIndex];

  const askLeave = useCallback(() => setConfirmLeave(true), []);
  const cancelLeave = useCallback(() => setConfirmLeave(false), []);
  const confirmLeaveNow = useCallback(() => {
    setConfirmLeave(false);
    leaveAndQuitRef.current();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const source = new NetworkedMatchSource({
      room,
      playerOrder,
      myPlayerId,
      seed,
      colorMode,
      dropQueue,
    });
    const input = new InputSystem();
    input.attach(window);
    const pixi = new PixiApp({ canvas, autoFit: true });
    const audio = createMatchAudio({ localPlayerId: myPlayerId });

    let cancelled = false;
    let scheduler: FrameScheduler | null = null;
    let sheet: PuyoSheet | null = null;
    let background: BackgroundRenderer | null = null;
    let leftField: FieldRenderer | null = null;
    let rightField: FieldRenderer | null = null;
    let leftNext: NextRenderer | null = null;
    let rightNext: NextRenderer | null = null;
    let matchEnded = false;
    let quitFired = false;
    let stallWatchdog: ReturnType<typeof setInterval> | null = null;
    let warnedStall = false;
    let tickingStarted = false;
    let beginFallback: ReturnType<typeof setTimeout> | null = null;

    // Single exit path back to the title. Leaves the room (so the
    // server frees it + awards the opponent the forfeit) exactly once,
    // no matter which trigger fired — quit button, connection loss, or
    // init failure.
    const quitOnce = () => {
      if (quitFired) return;
      quitFired = true;
      audio.stop();
      source.leaveRoom();
      onQuitRef.current();
    };
    leaveAndQuitRef.current = quitOnce;

    // The socket dropped before a clean finish (WiFi gone, server
    // redeployed, opponent's process killed). Surface it and bail to
    // the title instead of freezing on the last frame.
    source.onConnectionLost(() => {
      if (cancelled || matchEnded) return;
      setStatusMsg('対戦相手との接続が切れました');
      scheduler?.stop();
      // Give the banner a beat to register before we route away.
      setTimeout(() => quitOnce(), 1500);
    });

    const onEscape = (e: KeyboardEvent) => {
      if (e.code !== 'Escape') return;
      e.preventDefault();
      // Don't pile a second confirm on top of an open one — Esc inside
      // the dialog should close the dialog (cancel), not re-fire.
      if (confirmLeaveRef.current) {
        setConfirmLeave(false);
      } else {
        setConfirmLeave(true);
      }
    };
    window.addEventListener('keydown', onEscape);

    // Warn before a refresh / tab-close mid-match so the player doesn't
    // accidentally abandon a live game (which forfeits it). The browser
    // shows its own generic confirm when returnValue is set.
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (matchEnded || quitFired) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);

    Promise.all([pixi.init(), PuyoSheet.load(ASSET_BASE)])
      .then(([_, loadedSheet]) => {
        if (cancelled) {
          loadedSheet.destroy();
          pixi.destroy();
          return;
        }
        sheet = loadedSheet;
        background = new BackgroundRenderer();
        pixi.worldContainer.addChild(background.container);
        leftField = new FieldRenderer(loadedSheet);
        rightField = new FieldRenderer(loadedSheet);
        leftField.container.x = LEFT_OFFSET;
        rightField.container.x = RIGHT_OFFSET;
        pixi.worldContainer.addChild(leftField.container);
        pixi.worldContainer.addChild(rightField.container);

        leftNext = new NextRenderer(loadedSheet);
        // Right player's NEXT mirrors to the LEFT of its field, so the
        // panel doesn't run past the 1280-wide internal stage.
        rightNext = new NextRenderer(loadedSheet, { side: 'left' });
        leftNext.container.x = LEFT_OFFSET;
        rightNext.container.x = RIGHT_OFFSET;
        pixi.worldContainer.addChild(leftNext.container);
        pixi.worldContainer.addChild(rightNext.container);

        // We're fully loaded (assets + renderers). ACK readiness so the
        // server releases MATCH_BEGIN once BOTH players have loaded —
        // that's what makes the two sims start ticking together.
        try {
          room.send('MATCH_ACK', {});
        } catch {
          /* socket may have dropped during load */
        }

        // Match-start stinger + BGM, idempotent.
        void audio.start();

        source.onMatchEnd((winnerId, reason) => {
          if (matchEnded) return;
          matchEnded = true;
          audio.end();
          if (reason === 'desync') {
            setStatusMsg('通信エラーで対戦を終了しました（無効試合）');
          }
          const mine = source.match.players.find((p) => p.id === myPlayerId);
          const result: NetworkedMatchResult = {
            winnerId,
            myPlayerId,
            frame: source.match.frame,
            score: mine?.score ?? 0,
            maxChain: mine?.maxChain ?? 0,
            reason,
          };
          // On a desync, let the banner show briefly before routing to
          // the result screen; a normal finish transitions immediately.
          if (reason === 'desync') {
            setTimeout(() => {
              if (!cancelled) onEndRef.current(result);
            }, 1500);
          } else {
            onEndRef.current(result);
          }
        });

        scheduler = new FrameScheduler({
          source,
          input,
          onFrameAdvanced: (match: MatchState) => {
            audio.onFrameAdvanced(match);
            // Shake the field that's actually taking the hit. Local
            // player's drops shake the left field; opponent's drops
            // shake the right field. Tells the player at a glance
            // which side just got slammed.
            for (const ev of match.events) {
              if (ev.type !== 'ojama_drop' || ev.dropped <= 0) continue;
              if (ev.playerId === myPlayerId) leftField?.triggerShake(ev.dropped);
              else if (ev.playerId === opponentId) rightField?.triggerShake(ev.dropped);
            }
            const next: Record<PlayerId, PlayerHud> = {};
            for (const p of match.players) {
              next[p.id] = {
                nickname: nicknamesByPlayerId[p.id] ?? p.id,
                score: p.score,
                chain: p.chainCount,
                maxChain: p.maxChain,
                pendingOjama: p.pendingGarbage,
              };
            }
            setHuds(next);
          },
          onRender: (match) => {
            background?.tick();
            if (!leftField || !rightField) return;
            const myPlayer = match.players[myIndex];
            const oppPlayer = match.players[opponentIndex];
            if (myPlayer) leftField.update(myPlayer);
            if (oppPlayer) rightField.update(oppPlayer);
            leftNext?.update(match, myIndex);
            rightNext?.update(match, opponentIndex);
          },
        });
        // Gate the first tick on the server's synchronized MATCH_BEGIN so
        // both clients start together (see NetworkedMatchSource.onBegin).
        // If BEGIN already arrived during asset load, start immediately;
        // otherwise wait for it, with a fallback so a dropped BEGIN can't
        // hang the match forever.
        const beginTicking = () => {
          if (cancelled || tickingStarted || !scheduler) return;
          tickingStarted = true;
          if (beginFallback) {
            clearTimeout(beginFallback);
            beginFallback = null;
          }
          scheduler.start();
          setStatusMsg(null);
        };
        if (source.hasBegun) {
          beginTicking();
        } else {
          setStatusMsg('対戦開始を同期中…');
          source.onBegin(beginTicking);
          beginFallback = setTimeout(beginTicking, 2000);
        }

        // Stall watchdog: if the sim freezes on a missing batch for too
        // long, warn the player, then treat a very long stall as a lost
        // connection. The server force-flushes partial frames every
        // 200ms, so a multi-second client-side stall means OUR socket
        // is the problem — there's no recovery, only a graceful bail.
        stallWatchdog = setInterval(() => {
          if (cancelled || matchEnded || quitFired) return;
          const stalled = scheduler?.stalledForMs() ?? 0;
          if (stalled >= STALL_LOST_MS) {
            setStatusMsg('対戦相手との接続が切れました');
            scheduler?.stop();
            setTimeout(() => quitOnce(), 1500);
          } else if (stalled >= STALL_WARN_MS && !warnedStall) {
            warnedStall = true;
            setStatusMsg('通信が不安定です…');
          } else if (stalled === 0 && warnedStall) {
            warnedStall = false;
            setStatusMsg(null);
          }
        }, 500);
      })
      .catch((err) => {
        console.error('[NetworkedMatchScene] init failed:', err);
        if (!cancelled) {
          setStatusMsg('対戦の初期化に失敗しました');
          setTimeout(() => quitOnce(), 1500);
        }
      });

    return () => {
      cancelled = true;
      window.removeEventListener('keydown', onEscape);
      window.removeEventListener('beforeunload', onBeforeUnload);
      if (stallWatchdog) clearInterval(stallWatchdog);
      if (beginFallback) clearTimeout(beginFallback);
      audio.stop();
      scheduler?.dispose();
      leftField?.destroy();
      rightField?.destroy();
      leftNext?.destroy();
      rightNext?.destroy();
      background?.destroy();
      sheet?.destroy();
      pixi.destroy();
      input.dispose();
      // Always leave the room on unmount so the server frees it
      // instead of holding it open until the socket times out. After a
      // clean local finish the server is still in `running` (it never
      // saw a MATCH_END), so this leave also lets it tear the room
      // down. leaveRoom is best-effort + safe to call post-finish.
      source.leaveRoom();
      source.dispose();
    };
    // The Colyseus room handle, seed, and player roster are baked in
    // at scene-mount time; we deliberately don't restart on identity
    // changes of nicknamesByPlayerId (which can come from React
    // re-renders without changing semantics).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, myPlayerId, seed, colorMode]);

  const me = huds[myPlayerId];
  const opp = opponentId ? huds[opponentId] : undefined;

  return (
    <div className="scene match-scene networked-match-scene">
      <canvas ref={canvasRef} className="match-canvas" />

      <div className="vs-overlay vs-overlay-left">
        <div className="vs-name">{me?.nickname ?? myPlayerId}</div>
        <div className="vs-score">{me?.score.toLocaleString() ?? '0'}</div>
        <div className="vs-chain">
          CHAIN {me?.chain ?? 0} / {me?.maxChain ?? 0}
        </div>
        {!!me?.pendingOjama && <div className="vs-ojama">OJAMA {me.pendingOjama}</div>}
      </div>

      <div className="vs-overlay vs-overlay-right">
        <div className="vs-name">{opp?.nickname ?? opponentId ?? '-'}</div>
        <div className="vs-score">{opp?.score.toLocaleString() ?? '0'}</div>
        <div className="vs-chain">
          CHAIN {opp?.chain ?? 0} / {opp?.maxChain ?? 0}
        </div>
        {!!opp?.pendingOjama && <div className="vs-ojama">OJAMA {opp.pendingOjama}</div>}
      </div>

      {statusMsg && <div className="vs-status-banner">{statusMsg}</div>}
      <button type="button" className="vs-quit" onClick={askLeave}>
        退出
      </button>
      <div className="keyhint">←/→: 移動　Z/X: 回転　↓: ソフトドロップ　Esc: 退出</div>

      {confirmLeave && (
        // biome-ignore lint/a11y/useSemanticElements: transient game overlay
        <div className="pause-overlay" role="dialog" aria-modal>
          <div className="snes-window confirm-leave">
            <h2 className="confirm-leave-title">対戦から退出しますか？</h2>
            <p className="confirm-leave-detail">
              退出すると相手の勝ちとして記録され、再接続はできません。
            </p>
            <div className="confirm-leave-actions">
              <button type="button" className="pause-btn pause-btn-primary" onClick={cancelLeave}>
                続ける
              </button>
              <button
                type="button"
                className="pause-btn pause-btn-secondary"
                onClick={confirmLeaveNow}
              >
                退出する
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
