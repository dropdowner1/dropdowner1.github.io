/**
 * RecordsService — persists solo runs and online match outcomes,
 * plus the aggregate queries that back the rankings panels and the
 * "my records" page.
 *
 * Like AuthService it stays plain in/plain out so the routes layer
 * can call it from request handlers without leaking req/res types
 * into the persistence logic.
 */

import type {
  OnlineHistoryEntry,
  OnlineMatchRequest,
  OnlineRankingEntry,
  RecordsMeResponse,
  SoloBestEntry,
  SoloRunRequest,
} from '@chaindrop/shared/protocol';
import type { Database } from 'better-sqlite3';

export class RecordsService {
  constructor(private readonly db: Database) {}

  recordSoloRun(dbUserId: number, run: SoloRunRequest): void {
    this.db
      .prepare(
        `INSERT INTO solo_runs (user_id, score, max_chain, cells_cleared, played_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        dbUserId,
        Math.floor(run.score),
        Math.floor(run.maxChain),
        Math.floor(run.cellsCleared),
        new Date().toISOString(),
      );
  }

  recordOnlineMatch(dbUserId: number, match: OnlineMatchRequest): void {
    this.db
      .prepare(
        `INSERT INTO match_history (user_id, opponent_name, outcome, self_score, played_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        dbUserId,
        match.opponentName.slice(0, 40),
        match.outcome,
        Math.floor(match.selfScore),
        new Date().toISOString(),
      );
  }

  /** Aggregates for the logged-in player. Always returns something
   *  even when the player has no runs yet, so the client doesn't have
   *  to special-case empty results. */
  fetchRecordsFor(dbUserId: number): RecordsMeResponse {
    const aggRow = this.db
      .prepare(
        `SELECT
           COALESCE(MAX(score), 0)               AS best_score,
           COALESCE(MAX(max_chain), 0)           AS best_max_chain,
           COALESCE(SUM(cells_cleared), 0)       AS total_cleared
         FROM solo_runs
         WHERE user_id = ?`,
      )
      .get(dbUserId) as
      | { best_score: number; best_max_chain: number; total_cleared: number }
      | undefined;
    const solo = {
      bestScore: aggRow?.best_score ?? 0,
      bestMaxChain: aggRow?.best_max_chain ?? 0,
      totalCleared: aggRow?.total_cleared ?? 0,
    };

    const recentSolo = (
      this.db
        .prepare(
          `SELECT score, max_chain AS maxChain, cells_cleared AS cellsCleared,
                  played_at AS playedAt
           FROM solo_runs
           WHERE user_id = ?
           ORDER BY played_at DESC
           LIMIT 20`,
        )
        .all(dbUserId) as Array<{
        score: number;
        maxChain: number;
        cellsCleared: number;
        playedAt: string;
      }>
    ).map((r) => ({
      score: r.score,
      maxChain: r.maxChain,
      cellsCleared: r.cellsCleared,
      playedAt: r.playedAt,
    }));

    const online = (
      this.db
        .prepare(
          // Secondary sort on `id` so back-to-back inserts that share
          // a millisecond timestamp still come back newest-first.
          `SELECT played_at AS at, opponent_name AS opponentName,
                  outcome, self_score AS selfScore
           FROM match_history
           WHERE user_id = ?
           ORDER BY played_at DESC, id DESC
           LIMIT 50`,
        )
        .all(dbUserId) as Array<OnlineHistoryEntry>
    ).map((r) => ({
      at: r.at,
      opponentName: r.opponentName,
      outcome: r.outcome,
      selfScore: r.selfScore,
    }));

    return { solo, recentSolo, online };
  }

  /** Top N players by their personal best solo score. */
  soloRankings(limit = 20): SoloBestEntry[] {
    const rows = this.db
      .prepare(
        `SELECT
           u.user_id       AS userId,
           u.player_name   AS playerName,
           MAX(r.score)    AS bestScore,
           MAX(r.max_chain) AS bestMaxChain,
           SUM(r.cells_cleared) AS totalCleared
         FROM solo_runs r
         JOIN users u ON u.id = r.user_id
         GROUP BY r.user_id
         ORDER BY bestScore DESC
         LIMIT ?`,
      )
      .all(limit) as SoloBestEntry[];
    return rows;
  }

  onlineRankings(limit = 20): OnlineRankingEntry[] {
    const rows = this.db
      .prepare(
        `SELECT
           u.user_id     AS userId,
           u.player_name AS playerName,
           SUM(CASE WHEN m.outcome = 'win'  THEN 1 ELSE 0 END) AS wins,
           SUM(CASE WHEN m.outcome = 'loss' THEN 1 ELSE 0 END) AS losses,
           SUM(CASE WHEN m.outcome = 'draw' THEN 1 ELSE 0 END) AS draws
         FROM match_history m
         JOIN users u ON u.id = m.user_id
         GROUP BY m.user_id
         ORDER BY wins DESC, losses ASC
         LIMIT ?`,
      )
      .all(limit) as OnlineRankingEntry[];
    return rows;
  }
}
