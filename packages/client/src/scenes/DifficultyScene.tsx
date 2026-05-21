/**
 * DifficultyScene — the picker shown after "ソロプレイ" but before the
 * match starts. Six SNES-styled buttons in two rows; selecting one
 * fires `onConfirm(level)` which carries the chosen speed through to
 * MatchScene → LocalMatchSource → simulator.
 *
 * The last-chosen level is persisted to localStorage so repeat play
 * picks the same starting tier by default.
 */

import { useCallback, useState } from 'react';
import {
  DIFFICULTY_DEFS,
  type DifficultyLevel,
  loadDifficulty,
  saveDifficulty,
} from '../state/difficulty';

interface Props {
  onConfirm: (level: DifficultyLevel) => void;
  onBack: () => void;
}

export function DifficultyScene({ onConfirm, onBack }: Props) {
  const [selected, setSelected] = useState<DifficultyLevel>(() => loadDifficulty());

  const start = useCallback(() => {
    saveDifficulty(selected);
    onConfirm(selected);
  }, [selected, onConfirm]);

  return (
    <div className="scene title-scene">
      <div className="snes-window difficulty-window">
        <h2 className="difficulty-title">難易度</h2>
        <div className="difficulty-grid">
          {DIFFICULTY_DEFS.map((d) => (
            <button
              key={d.id}
              type="button"
              className={`difficulty-cell ${selected === d.id ? 'on' : ''}`}
              onClick={() => setSelected(d.id)}
            >
              <span className="difficulty-cell-label">{d.label}</span>
              <span className="difficulty-cell-hint">{d.hint}</span>
            </button>
          ))}
        </div>
        <div className="difficulty-actions">
          <button type="button" className="pause-btn pause-btn-primary" onClick={start}>
            スタート
          </button>
          <button type="button" className="pause-btn pause-btn-secondary" onClick={onBack}>
            もどる
          </button>
        </div>
      </div>
    </div>
  );
}
