/**
 * RankingsScene — solo bests + recent online match history.
 *
 * Phase A reads everything from localStorage (`state/records.ts`).
 * Phase B will swap the same component to a fetch against the
 * accounts backend, but the data shape lines up so the layout
 * doesn't have to change.
 */

import { useEffect, useState } from 'react';
import { type Records, loadRecords } from '../state/records';

interface Props {
  onBack: () => void;
}

export function RankingsScene({ onBack }: Props) {
  const [records, setRecords] = useState<Records>(() => loadRecords());

  useEffect(() => {
    // Re-read on mount in case the user just finished a match before
    // navigating here.
    setRecords(loadRecords());
  }, []);

  const winCount = records.online.filter((e) => e.outcome === 'win').length;
  const lossCount = records.online.filter((e) => e.outcome === 'loss').length;

  return (
    <div className="scene rankings-scene">
      <div className="rankings-header">
        <h2>ランキング・戦績</h2>
        <button type="button" className="lobby-back" onClick={onBack}>
          戻る
        </button>
      </div>

      <section className="rankings-section snes-window">
        <h3 className="rankings-section-title">ソロプレイ</h3>
        <dl className="rankings-grid">
          <div>
            <dt>ベストスコア</dt>
            <dd>{records.solo.bestScore.toLocaleString()}</dd>
          </div>
          <div>
            <dt>最大連鎖</dt>
            <dd>{records.solo.bestMaxChain}</dd>
          </div>
          <div>
            <dt>消したぷよ総数</dt>
            <dd>{records.solo.totalCleared.toLocaleString()}</dd>
          </div>
        </dl>
        {records.solo.bestScoreAt && (
          <p className="rankings-stamp">最高記録: {formatStamp(records.solo.bestScoreAt)}</p>
        )}
      </section>

      <section className="rankings-section snes-window">
        <h3 className="rankings-section-title">オンライン戦績</h3>
        <p className="rankings-online-summary">
          {winCount} 勝 {lossCount} 敗
        </p>
        {records.online.length === 0 ? (
          <p className="rankings-empty">まだ対戦記録はありません</p>
        ) : (
          <ol className="rankings-online-list">
            {records.online.slice(0, 20).map((entry, idx) => (
              <li key={`${entry.at}-${idx}`} className={`outcome-${entry.outcome}`}>
                <span className="rankings-outcome">{outcomeLabel(entry.outcome)}</span>
                <span className="rankings-opp">vs {entry.opponentNickname}</span>
                <span className="rankings-score">{entry.selfScore.toLocaleString()}</span>
                <span className="rankings-at">{formatStamp(entry.at)}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <p className="rankings-footnote">
        Phase A の戦績はこの端末内（localStorage）に保存されています。アカウント機能完成後、
        サーバ集計の本ランキングに切り替わります。
      </p>
    </div>
  );
}

function outcomeLabel(o: 'win' | 'loss' | 'draw'): string {
  return o === 'win' ? 'WIN' : o === 'loss' ? 'LOSE' : 'DRAW';
}

function formatStamp(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(
      d.getHours(),
    )}:${pad(d.getMinutes())}`;
  } catch {
    return iso;
  }
}
