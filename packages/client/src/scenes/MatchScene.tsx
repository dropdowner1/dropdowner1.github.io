import type { MatchState } from '@chaindrop/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { postSoloRun } from '../api/records';
import { audioBus } from '../audio/AudioBus';
import { createMatchAudio } from '../audio/MatchAudio';
import { SettingsDialog } from '../components/SettingsDialog';
import { InputSystem } from '../input/InputSystem';
import { FieldRenderer } from '../renderer/FieldRenderer';
import { NextRenderer } from '../renderer/NextRenderer';
import { PixiApp } from '../renderer/PixiApp';
import { PuyoSheet } from '../renderer/PuyoTexture';
import { FrameScheduler } from '../simulator/FrameScheduler';
import { LocalMatchSource } from '../simulator/LocalMatchSource';
import { applyColorModeToApp } from '../state/colorMode';
import { type Records, loadRecords, recordSoloRun } from '../state/records';
import { loadSettings } from '../state/settings';

const ASSET_BASE = import.meta.env.BASE_URL;

export interface MatchResult {
  score: number;
  maxChain: number;
  frame: number;
}

interface Props {
  seed?: number;
  colorMode?: 4 | 5;
  /** Frames per cell of natural gravity at match start. */
  fallIntervalNormal?: number;
  onEnd: (result: MatchResult) => void;
  onQuit: () => void;
}

interface SoloHud {
  score: number;
  chain: number;
  maxChain: number;
  cleared: number;
  /** Unsent + unoffset garbage queued against the player. */
  pendingOjama: number;
}

export function MatchScene({ seed, colorMode = 4, fallIntervalNormal, onEnd, onQuit }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hud, setHud] = useState<SoloHud>({
    score: 0,
    chain: 0,
    maxChain: 0,
    cleared: 0,
    pendingOjama: 0,
  });
  const [paused, setPaused] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const onEndRef = useRef(onEnd);
  const onQuitRef = useRef(onQuit);
  onEndRef.current = onEnd;
  onQuitRef.current = onQuit;

  const schedulerRef = useRef<FrameScheduler | null>(null);
  const pausedRef = useRef(false);
  /** Pixi app handle exposed so the SettingsDialog can re-apply the
   *  color-mode filter live as the user toggles modes. */
  const pixiRef = useRef<PixiApp | null>(null);

  const resume = useCallback(() => {
    setPaused(false);
    setShowSettings(false);
    pausedRef.current = false;
    schedulerRef.current?.start();
    // Re-read settings on resume so a BGM-volume change made in the
    // pause menu's settings dialog takes effect; don't force BGM back
    // on when the player has it muted (volume 0).
    const settings = loadSettings();
    audioBus.setBgmVolume(settings.bgmVolume);
    audioBus.setSeVolume(settings.seVolume);
    if (settings.bgmVolume > 0) {
      void audioBus.ensureUnlocked().then(() => audioBus.startBgm());
    }
  }, []);

  const pause = useCallback(() => {
    setPaused(true);
    pausedRef.current = true;
    schedulerRef.current?.stop();
    audioBus.stopBgm();
  }, []);

  const togglePause = useCallback(() => {
    if (pausedRef.current) resume();
    else pause();
  }, [pause, resume]);

  const handleQuit = useCallback(() => {
    pausedRef.current = false;
    schedulerRef.current?.stop();
    audioBus.stopBgm();
    onQuitRef.current();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const actualSeed = seed ?? Math.floor(Math.random() * 0xffffffff);
    const source = new LocalMatchSource({
      seed: actualSeed,
      colorMode,
      ...(fallIntervalNormal !== undefined && { fallIntervalNormal }),
    });
    const input = new InputSystem();
    input.attach(window);

    const pixi = new PixiApp({ canvas, autoFit: true });
    pixiRef.current = pixi;

    let renderer: FieldRenderer | null = null;
    let nextRenderer: NextRenderer | null = null;
    let scheduler: FrameScheduler | null = null;
    let sheet: PuyoSheet | null = null;
    let cancelled = false;
    let matchEnded = false;
    const audio = createMatchAudio({ localPlayerId: source.myPlayerId });

    const onEscape = (e: KeyboardEvent) => {
      if (e.code !== 'Escape') return;
      e.preventDefault();
      togglePause();
    };
    window.addEventListener('keydown', onEscape);

    Promise.all([pixi.init(), PuyoSheet.load(ASSET_BASE)])
      .then(([_, loadedSheet]) => {
        if (cancelled) {
          loadedSheet.destroy();
          pixi.destroy();
          return;
        }
        sheet = loadedSheet;
        renderer = new FieldRenderer(loadedSheet);
        nextRenderer = new NextRenderer(loadedSheet);
        pixi.worldContainer.addChild(renderer.container);
        pixi.worldContainer.addChild(nextRenderer.container);

        // Apply the saved color mode to the freshly-mounted stage.
        applyColorModeToApp(pixi.app, loadSettings().colorMode);

        // Match-start stinger + BGM, idempotent.
        void audio.start();

        source.onMatchEnd(() => {
          if (matchEnded) return;
          matchEnded = true;
          audio.end();
          const p = source.match.players[0];
          const result: MatchResult = {
            score: p?.score ?? 0,
            maxChain: p?.maxChain ?? 0,
            frame: source.match.frame,
          };
          // Always persist locally so guests still get a record on
          // the title marquee. Logged-in players get a parallel push
          // to the server; failures stay silent (the records api
          // logs and swallows).
          const prev: Records = loadRecords();
          const runPayload = {
            score: result.score,
            maxChain: result.maxChain,
            totalCleared: p?.cellsCleared ?? 0,
          };
          recordSoloRun(prev, runPayload);
          void postSoloRun({
            score: runPayload.score,
            maxChain: runPayload.maxChain,
            cellsCleared: runPayload.totalCleared,
          });
          onEndRef.current(result);
        });

        scheduler = new FrameScheduler({
          source,
          input,
          onFrameAdvanced: (match: MatchState) => {
            const p = match.players[0];
            if (!p) return;
            audio.onFrameAdvanced(match);
            // Shake on incoming garbage. The drop event is per-player;
            // solo has no opponent so this is mostly future-proofing —
            // a self-targeted dropped count still applies.
            for (const ev of match.events) {
              if (ev.type === 'ojama_drop' && ev.playerId === p.id && ev.dropped > 0) {
                renderer?.triggerShake(ev.dropped);
              }
            }
            setHud({
              score: p.score,
              chain: p.chainCount,
              maxChain: p.maxChain,
              cleared: p.cellsCleared,
              pendingOjama: p.pendingGarbage,
            });
          },
          onRender: (match) => {
            const p = match.players[0];
            if (!p || !renderer) return;
            renderer.update(p);
            nextRenderer?.update(match);
          },
        });
        schedulerRef.current = scheduler;
        scheduler.start();
      })
      .catch((err) => {
        console.error('[MatchScene] init failed:', err);
        onQuitRef.current();
      });

    return () => {
      cancelled = true;
      window.removeEventListener('keydown', onEscape);
      schedulerRef.current = null;
      pixiRef.current = null;
      audioBus.stopBgm();
      scheduler?.dispose();
      renderer?.destroy();
      nextRenderer?.destroy();
      sheet?.destroy();
      pixi.destroy();
      input.dispose();
      source.dispose();
    };
  }, [seed, colorMode, fallIntervalNormal, togglePause]);

  return (
    <div className="scene match-scene">
      <canvas ref={canvasRef} className="match-canvas" />
      <div className="match-overlay">
        <div className="overlay-panel score-panel">
          <div className="panel-label">SCORE</div>
          <div className="panel-value digital">{hud.score.toLocaleString()}</div>
        </div>
        <div className="overlay-panel chain-panel">
          <div className="panel-label">CHAIN</div>
          <div className="panel-value">
            {hud.chain} <span className="panel-sub">/ {hud.maxChain}</span>
          </div>
        </div>
        <div className="overlay-panel cleared-panel">
          <div className="panel-label">CLEARED</div>
          <div className="panel-value">{hud.cleared.toLocaleString()}</div>
        </div>
        {hud.pendingOjama > 0 && (
          <div className="overlay-panel ojama-panel">
            <div className="panel-label">OJAMA</div>
            <div className="panel-value">{hud.pendingOjama}</div>
          </div>
        )}
      </div>
      <div className="keyhint">
        ←/→: 移動　Z/X: 回転　↓: ソフトドロップ　Space: ハードドロップ　Esc: ポーズ
      </div>

      {paused && (
        // biome-ignore lint/a11y/useSemanticElements: transient game overlay
        <div className="pause-overlay" role="dialog" aria-modal>
          {showSettings ? (
            <SettingsDialog
              onClose={() => setShowSettings(false)}
              onColorModeChange={(mode) => applyColorModeToApp(pixiRef.current?.app ?? null, mode)}
            />
          ) : (
            <div className="pause-menu snes-window">
              <h2 className="pause-title">ポーズ</h2>
              <button type="button" className="pause-btn pause-btn-primary" onClick={resume}>
                続ける
              </button>
              <button
                type="button"
                className="pause-btn pause-btn-secondary"
                onClick={() => setShowSettings(true)}
              >
                設定
              </button>
              <button type="button" className="pause-btn pause-btn-secondary" onClick={handleQuit}>
                メニューに戻る
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
