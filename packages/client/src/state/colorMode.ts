/**
 * Applies the selected `ColorMode` to two surfaces:
 *
 *   1. The DOM, by setting `data-color-mode` on <html>. The
 *      `global.css` stylesheet then swaps accent CSS variables under
 *      the matching attribute selector, so React UI re-themes
 *      automatically.
 *
 *   2. The Pixi stage, by installing / clearing a `ColorMatrixFilter`
 *      on the `PixiApp`'s stage. Mono runs a full desaturate (good
 *      for accessibility AND the "no colour cues, harder game"
 *      difficulty mode the user asked for); high-contrast boosts
 *      saturation and brightness so the puyo silhouettes pop on dim
 *      monitors.
 *
 * Both surfaces are driven from the same setting, which is persisted
 * in `state/settings.ts`. Scenes call `applyColorMode(...)` on mount
 * and whenever the settings dialog changes the value.
 */

import { ColorMatrixFilter } from 'pixi.js';
import type { Application } from 'pixi.js';
import type { ColorMode } from './settings';

export function applyColorModeDom(mode: ColorMode): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.colorMode = mode;
}

export function applyColorModeToApp(app: Application | null, mode: ColorMode): void {
  if (!app) return;
  if (mode === 'standard') {
    app.stage.filters = [];
    return;
  }
  const filter = new ColorMatrixFilter();
  if (mode === 'mono') {
    // 100% desaturate.
    filter.desaturate();
  } else {
    // high-contrast: saturate and brighten slightly. ColorMatrixFilter
    // expects a 0..1ish saturate amount; over-cranking can clip but on
    // the chunky puyo sprites it just reads as "the colors snap".
    filter.saturate(0.6, false);
    filter.brightness(1.1, true);
    filter.contrast(0.3, true);
  }
  app.stage.filters = [filter];
}
