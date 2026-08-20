/**
 * Persisted player records: best solo run + a short history of online
 * match outcomes. Lives in localStorage until Phase B's account
 * backend takes over; in the meantime it powers the title-screen
 * marquee and the ランキング・戦績 panel.
 */

import { notifyLocalStateChanged } from './persistBus';

export interface SoloBest {
  bestScore: number;
  bestMaxChain: number;
  totalCleared: number;
  /** ISO timestamp of the run that produced bestScore. */
  bestScoreAt: string | null;
}

export interface OnlineHistoryEntry {
  /** ISO timestamp of when the match ended. */
  at: string;
  opponentNickname: string;
  outcome: 'win' | 'loss' | 'draw';
  selfScore: number;
}

export interface Records {
  solo: SoloBest;
  online: OnlineHistoryEntry[];
}

export const EMPTY_RECORDS: Records = {
  solo: { bestScore: 0, bestMaxChain: 0, totalCleared: 0, bestScoreAt: null },
  online: [],
};

const STORAGE_KEY = 'chaindrop.records.v1';
/** Cap the online history list so localStorage doesn't grow unbounded. */
export const HISTORY_LIMIT = 50;

export function loadRecords(): Records {
  if (typeof window === 'undefined' || !window.localStorage) return EMPTY_RECORDS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_RECORDS;
    const parsed = JSON.parse(raw) as Partial<Records>;
    return {
      solo: {
        bestScore: numOr(parsed.solo?.bestScore, 0),
        bestMaxChain: numOr(parsed.solo?.bestMaxChain, 0),
        totalCleared: numOr(parsed.solo?.totalCleared, 0),
        bestScoreAt: typeof parsed.solo?.bestScoreAt === 'string' ? parsed.solo.bestScoreAt : null,
      },
      online: Array.isArray(parsed.online) ? parsed.online.slice(0, HISTORY_LIMIT) : [],
    };
  } catch {
    return EMPTY_RECORDS;
  }
}

export function saveRecords(records: Records): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch {
    /* ignore */
  }
  notifyLocalStateChanged();
}

export interface SoloRunResult {
  score: number;
  maxChain: number;
  totalCleared: number;
}

/**
 * Merge a finished solo run into the persisted bests. Returns the new
 * Records object so callers can re-render off it without re-reading.
 * - bestScore: rolling max across runs
 * - bestMaxChain: rolling max
 * - totalCleared: cumulative (we add every run)
 */
export function recordSoloRun(prev: Records, run: SoloRunResult): Records {
  const beats = run.score > prev.solo.bestScore;
  const next: Records = {
    solo: {
      bestScore: Math.max(prev.solo.bestScore, run.score),
      bestMaxChain: Math.max(prev.solo.bestMaxChain, run.maxChain),
      totalCleared: prev.solo.totalCleared + Math.max(0, run.totalCleared),
      bestScoreAt: beats ? new Date().toISOString() : prev.solo.bestScoreAt,
    },
    online: prev.online,
  };
  saveRecords(next);
  return next;
}

export function appendOnlineHistory(prev: Records, entry: OnlineHistoryEntry): Records {
  const next: Records = {
    solo: prev.solo,
    online: [entry, ...prev.online].slice(0, HISTORY_LIMIT),
  };
  saveRecords(next);
  return next;
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
