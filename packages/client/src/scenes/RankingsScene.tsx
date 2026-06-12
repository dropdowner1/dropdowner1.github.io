/**
 * RankingsScene — solo bests + recent online match history + global
 * leaderboards.
 *
 * Guests see their localStorage records (Phase A behaviour).
 * Logged-in players also pull personal aggregates from `/api/records/me`
 * and the top-N solo leaderboard from `/api/rankings/solo`. The local
 * cache is rendered immediately so the screen is never blank during
 * the network round-trip.
 */

import type { RecordsMeResponse, SoloBestEntry } from '@chaindrop/shared/protocol';
import { useCallback, useEffect, useState } from 'react';
import { fetchMyRecords, fetchSoloRankings } from '../api/records';
import { useSession } from '../state/SessionContext';
import { type Records, loadRecords } from '../state/records';

interface Props {
  onBack: () => void;
}

export function RankingsScene({ onBack }: Props) {
  const { user } = useSession();
  const [records, setRecords] = useState<Records>(() => loadRecords());
  const [serverRecords, setServerRecords] = useState<RecordsMeResponse | null>(null);
  const [soloLeaderboard, setSoloLeaderboard] = useState<SoloBestEntry[] | null>(null);
  /** True when a server fetch failed — distinguishes "empty" from
   *  "couldn't reach the server" and lets the player retry. */
  const [fetchError, setFetchError] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    setRecords(loadRecords());
    setFetchError(false);
    void fetchSoloRankings()
      .then((res) => setSoloLeaderboard(res.rankings))
      .catch(() => {
        setSoloLeaderboard([]);
        setFetchError(true);
      });
    if (user) {
      void fetchMyRecords()
        .then((res) => {
          if (res) setServerRecords(res);
        })
        .catch(() => setFetchError(true));
    } else {
      setServerRecords(null);
    }
  }, [user, refreshKey]);

  const reload = useCallback(() => setRefreshKey((k) => k + 1), []);

  // Logged-in: server is the source of truth. Guest: local cache.
  const solo = serverRecords?.solo ?? {
    bestScore: records.solo.bestScore,
    bestMaxChain: records.solo.bestMaxChain,
    totalCleared: records.solo.totalCleared,
  };
  const online =
    serverRecords?.online ??
    records.online.map((e) => ({
      at: e.at,
      opponentName: e.opponentNickname,
      outcome: e.outcome,
      selfScore: e.selfScore,
    }));

  const winCount = online.filter((e) => e.outcome === 'win').length;
  const lossCount = online.filter((e) => e.outcome === 'loss').length;

  return (
    <div className="scene rankings-scene">
      <div className="rankings-header">
        <h2>ランキング・戦績</h2>
        <button type="button" className="lobby-back" onClick={onBack}>
          戻る
        </button>
      </div>

      {fetchError && (
        <div className="lobby-error-row">
          <p className="lobby-error">
            サーバから最新の記録を取得できませんでした（端末内の記録を表示中）
          </p>
          <button type="button" className="lobby-retry" onClick={reload}>
            再読み込み
          </button>
        </div>
      )}

      <section className="rankings-section snes-window">
        <h3 className="rankings-section-title">
          {user ? `${user.playerName} のソロプレイ` : 'ソロプレイ（ゲスト・端末内）'}
        </h3>
        <dl className="rankings-grid">
          <div>
            <dt>ベストスコア</dt>
            <dd>{solo.bestScore.toLocaleString()}</dd>
          </div>
          <div>
            <dt>最大連鎖</dt>
            <dd>{solo.bestMaxChain}</dd>
          </div>
          <div>
            <dt>消したぷよ総数</dt>
            <dd>{solo.totalCleared.toLocaleString()}</dd>
          </div>
        </dl>
        {!user && records.solo.bestScoreAt && (
          <p className="rankings-stamp">最高記録: {formatStamp(records.solo.bestScoreAt)}</p>
        )}
      </section>

      <section className="rankings-section snes-window">
        <h3 className="rankings-section-title">オンライン戦績</h3>
        <p className="rankings-online-summary">
          {winCount} 勝 {lossCount} 敗
        </p>
        {online.length === 0 ? (
          <p className="rankings-empty">まだ対戦記録はありません</p>
        ) : (
          <ol className="rankings-online-list">
            {online.slice(0, 20).map((entry, idx) => (
              <li key={`${entry.at}-${idx}`} className={`outcome-${entry.outcome}`}>
                <span className="rankings-outcome">{outcomeLabel(entry.outcome)}</span>
                <span className="rankings-opp">vs {entry.opponentName}</span>
                <span className="rankings-score">{entry.selfScore.toLocaleString()}</span>
                <span className="rankings-at">{formatStamp(entry.at)}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="rankings-section snes-window">
        <h3 className="rankings-section-title">ソロ全体ランキング</h3>
        {soloLeaderboard === null ? (
          <p className="rankings-empty">取得中…</p>
        ) : fetchError ? (
          <p className="rankings-empty">ランキングを取得できませんでした</p>
        ) : soloLeaderboard.length === 0 ? (
          <p className="rankings-empty">まだ誰もスコアを残していません</p>
        ) : (
          <ol className="rankings-leaderboard">
            {soloLeaderboard.map((row, idx) => (
              <li key={row.userId}>
                <span className="rankings-rank">#{idx + 1}</span>
                <span className="rankings-opp">{row.playerName}</span>
                <span className="rankings-score">{row.bestScore.toLocaleString()}</span>
                <span className="rankings-at">
                  最大連鎖 {row.bestMaxChain} · {row.totalCleared.toLocaleString()} 個
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <p className="rankings-footnote">
        {user
          ? 'ログイン中のアカウントの記録です。'
          : '端末内（localStorage）の記録です。ログインするとサーバに保存され、他端末からも見られるようになります。'}
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
