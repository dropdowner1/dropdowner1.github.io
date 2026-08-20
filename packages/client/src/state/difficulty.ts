/**
 * Solo-play difficulty levels.
 *
 * Each level maps to a `fallIntervalNormal` (starting frames-per-cell
 * for natural gravity). Smaller = faster.
 *
 *   激甘 72  ── twice as slow as 普通; for absolute beginners
 *   甘口 54
 *   普通 36  ── the simulator default ([[user_profile]] preferred "current speed")
 *   中辛 24
 *   辛口 16
 *   激辛 12  ── three-times-faster than 普通; expert tier
 *
 * The progressive speed-up curve in `fallIntervalForCleared` still
 * applies on top of whichever value we hand it, so all difficulties
 * eventually trend toward `FALL_INTERVAL_MIN = 6`.
 */

import { notifyLocalStateChanged } from './persistBus';

export type DifficultyLevel =
  | 'gekikan'
  | 'amakuchi'
  | 'futsuu'
  | 'chukara'
  | 'karakuchi'
  | 'gekikara';

export interface DifficultyDef {
  id: DifficultyLevel;
  /** Japanese label shown in the picker. */
  label: string;
  /** One-line subtitle so first-time players know what they're picking. */
  hint: string;
  /** Starting frames-per-cell for natural gravity. */
  fallIntervalNormal: number;
}

export const DIFFICULTY_DEFS: readonly DifficultyDef[] = [
  { id: 'gekikan', label: '激甘', hint: 'ぷよ初挑戦の方向け', fallIntervalNormal: 72 },
  { id: 'amakuchi', label: '甘口', hint: 'のんびり積みたい', fallIntervalNormal: 54 },
  { id: 'futsuu', label: '普通', hint: '標準スピード', fallIntervalNormal: 36 },
  { id: 'chukara', label: '中辛', hint: '少し忙しい', fallIntervalNormal: 24 },
  { id: 'karakuchi', label: '辛口', hint: '判断力勝負', fallIntervalNormal: 16 },
  { id: 'gekikara', label: '激辛', hint: 'ガチ勢専用', fallIntervalNormal: 12 },
];

export const DEFAULT_DIFFICULTY: DifficultyLevel = 'futsuu';

const STORAGE_KEY = 'chaindrop.difficulty.v1';

export function loadDifficulty(): DifficultyLevel {
  if (typeof window === 'undefined' || !window.localStorage) return DEFAULT_DIFFICULTY;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_DIFFICULTY;
    if (DIFFICULTY_DEFS.some((d) => d.id === raw)) return raw as DifficultyLevel;
  } catch {
    /* ignore */
  }
  return DEFAULT_DIFFICULTY;
}

export function saveDifficulty(id: DifficultyLevel): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* ignore */
  }
  notifyLocalStateChanged();
}

export function fallIntervalFor(id: DifficultyLevel): number {
  const def = DIFFICULTY_DEFS.find((d) => d.id === id);
  return def?.fallIntervalNormal ?? 36;
}
