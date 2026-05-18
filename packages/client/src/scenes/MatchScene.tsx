import type { MatchState } from '@chaindrop/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { InputSystem } from '../input/InputSystem';
import { FieldRenderer } from '../renderer/FieldRenderer';
import { NextRenderer } from '../renderer/NextRenderer';
import { PixiApp } from '../renderer/PixiApp';
import { PuyoSheet } from '../renderer/PuyoTexture';
import { FrameScheduler } from '../simulator/FrameScheduler';
import { LocalMatchSource } from '../simulator/LocalMatchSource';

/**
 * Vite rewrites its output with a runtime base path. Passing
 * `import.meta.env.BASE_URL` to Pixi's asset loader ensures the sheet
 * resolves correctly on both the dev server and a GitHub Pages subpath.
 */
const ASSET_BASE = import.meta.env.BASE_URL;

export interface MatchResult {
  score: number;
  maxChain: number;
  frame: number;
}

interface Props {
  seed?: number;
  colorMode?: 4 | 5;
  onEnd: (result: MatchResult) => void;
  onQuit: () => void;
}

interface SoloHud {
  score: number;
  chain: number;
  maxChain: number;
  cleared: number;
}

export function MatchScene({ seed, colorMode = 4, onEnd, onQuit }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hud, setHud] = useState<SoloHud>({ score: 0, chain: 0, maxChain: 0, cleared: 0 });
  const [paused, setPaused] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const onEndRef = useRef(onEnd);
  const onQuitRef = useRef(onQuit);
  onEndRef.current = onEnd;
  onQuitRef.current = onQuit;

  /** Scheduler lives in a ref so the pause/resume buttons can reach it
   *  without re-running the heavy init effect. */
  const schedulerRef = useRef<FrameScheduler | null>(null);
  const pausedRef = useRef(false);

  const resume = useCallback(() => {
    setPaused(false);
    setShowSettings(false);
    pausedRef.current = false;
    schedulerRef.current?.start();
  }, []);

  const pause = useCallback(() => {
    setPaused(true);
    pausedRef.current = true;
    schedulerRef.current?.stop();
  }, []);

  const togglePause = useCallback(() => {
    if (pausedRef.current) resume();
    else pause();
  }, [pause, resume]);

  const handleQuit = useCallback(() => {
    pausedRef.current = false;
    schedulerRef.current?.stop();
    onQuitRef.current();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const actualSeed = seed ?? Math.floor(Math.random() * 0xffffffff);
    const source = new LocalMatchSource({ seed: actualSeed, colorMode });
    const input = new InputSystem();
    input.attach(window);

    const pixi = new PixiApp({ canvas, autoFit: true });

    let renderer: FieldRenderer | null = null;
    let nextRenderer: NextRenderer | null = null;
    let scheduler: FrameScheduler | null = null;
    let sheet: PuyoSheet | null = null;
    let cancelled = false;
    let matchEnded = false;

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

        source.onMatchEnd(() => {
          if (matchEnded) return;
          matchEnded = true;
          const p = source.match.players[0];
          onEndRef.current({
            score: p?.score ?? 0,
            maxChain: p?.maxChain ?? 0,
            frame: source.match.frame,
          });
        });

        scheduler = new FrameScheduler({
          source,
          input,
          onFrameAdvanced: (match: MatchState) => {
            const p = match.players[0];
            if (!p) return;
            setHud({
              score: p.score,
              chain: p.chainCount,
              maxChain: p.maxChain,
              cleared: p.cellsCleared,
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
      scheduler?.dispose();
      renderer?.destroy();
      nextRenderer?.destroy();
      sheet?.destroy();
      pixi.destroy();
      input.dispose();
      source.dispose();
    };
  }, [seed, colorMode, togglePause]);

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
      </div>
      <div className="keyhint">←/→: 移動 Z/X: 回転 ↓: ソフトドロップ Esc: ポーズ</div>

      {paused && (
        // biome-ignore lint/a11y/useSemanticElements: pause is a transient game overlay, not a focus-trapped modal dialog — using <dialog> would also hijack Esc and break our scheduler-pause control
        <div className="pause-overlay" role="dialog" aria-modal>
          {showSettings ? (
            <div className="pause-menu">
              <h2 className="pause-title">設定</h2>
              <p className="pause-settings-stub">設定項目は今後追加予定です。</p>
              <button
                type="button"
                className="pause-btn pause-btn-secondary"
                onClick={() => setShowSettings(false)}
              >
                戻る
              </button>
            </div>
          ) : (
            <div className="pause-menu">
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
