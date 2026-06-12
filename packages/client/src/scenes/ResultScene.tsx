import { useEffect, useState } from 'react';
import { HowToPlayDialog } from '../components/HowToPlayDialog';
import type { MatchResult } from './MatchScene';

interface Props {
  result: MatchResult;
  onRestart: () => void;
  onTitle: () => void;
}

export function ResultScene({ result, onRestart, onTitle }: Props) {
  const [showHowTo, setShowHowTo] = useState(false);

  useEffect(() => {
    if (showHowTo) return; // dialog owns Enter/Esc while open
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Enter') {
        e.preventDefault();
        onRestart();
      } else if (e.code === 'Escape') {
        e.preventDefault();
        onTitle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onRestart, onTitle, showHowTo]);

  const minutes = Math.floor(result.frame / 60 / 60);
  const seconds = Math.floor((result.frame / 60) % 60);
  const durationText = `${minutes}:${seconds.toString().padStart(2, '0')}`;

  return (
    <div className="scene result-scene">
      <div className="result-content">
        <h1 className="result-title">GAME OVER</h1>
        <dl className="result-stats">
          <div>
            <dt>SCORE</dt>
            <dd className="digital">{result.score.toLocaleString()}</dd>
          </div>
          <div>
            <dt>MAX CHAIN</dt>
            <dd className="digital">{result.maxChain}</dd>
          </div>
          <div>
            <dt>TIME</dt>
            <dd className="digital">{durationText}</dd>
          </div>
        </dl>
        <div className="result-buttons">
          <button type="button" onClick={onRestart} className="result-btn primary">
            PLAY AGAIN
          </button>
          <button type="button" onClick={onTitle} className="result-btn secondary">
            BACK TO TITLE
          </button>
          <button type="button" onClick={() => setShowHowTo(true)} className="result-btn secondary">
            遊び方
          </button>
        </div>
      </div>
      <div className="keyhint">Enter: もう一度 Esc: タイトルへ</div>
      {showHowTo && (
        <div className="pause-overlay">
          <HowToPlayDialog onClose={() => setShowHowTo(false)} />
        </div>
      )}
    </div>
  );
}
