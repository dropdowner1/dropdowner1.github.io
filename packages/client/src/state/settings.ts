/**
 * Persisted user-facing settings (audio volumes, color mode).
 *
 * Stored under a single localStorage key as a small JSON blob so a
 * future schema migration can be done with a version bump rather than
 * scanning loose keys. Defaults are returned whenever the parse fails
 * (missing field, corrupted blob, etc.) so the app boots cleanly even
 * on first run.
 */

import { notifyLocalStateChanged } from './persistBus';

export type ColorMode = 'standard' | 'high-contrast' | 'mono';

export interface Settings {
  /** 0..10, mapped to a 0..1 gain. */
  bgmVolume: number;
  seVolume: number;
  colorMode: ColorMode;
}

export const DEFAULT_SETTINGS: Settings = {
  bgmVolume: 5,
  seVolume: 7,
  colorMode: 'standard',
};

const STORAGE_KEY = 'chaindrop.settings.v1';

export function loadSettings(): Settings {
  if (typeof window === 'undefined' || !window.localStorage) return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      bgmVolume: clampVolume(parsed.bgmVolume ?? DEFAULT_SETTINGS.bgmVolume),
      seVolume: clampVolume(parsed.seVolume ?? DEFAULT_SETTINGS.seVolume),
      colorMode: isColorMode(parsed.colorMode) ? parsed.colorMode : DEFAULT_SETTINGS.colorMode,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: Settings): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* quota exceeded / privacy mode — silently ignore. */
  }
  notifyLocalStateChanged();
}

function clampVolume(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(10, Math.round(v)));
}

function isColorMode(v: unknown): v is ColorMode {
  return v === 'standard' || v === 'high-contrast' || v === 'mono';
}
