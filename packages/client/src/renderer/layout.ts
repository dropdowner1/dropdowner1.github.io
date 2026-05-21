/**
 * Pure geometry and palette for the main field renderer.
 *
 * The solo-layout dimensions here are a slight simplification of
 * D7 §8.1: field sits slightly right-of-center with room on the
 * left for a character portrait (later) and on the right for the
 * NEXT column and score. All numbers are in the 1280×720 internal
 * coordinate space.
 */

import type { CellKind, PuyoColor } from '@chaindrop/shared';

export const INTERNAL_WIDTH = 1280;
export const INTERNAL_HEIGHT = 720;

/** Main-field cell size in pixels. Bumped from 40 → 48 (20% bigger). */
export const CELL_SIZE = 48;
/** Number of columns on the board. */
export const FIELD_COLS = 6;
/** Number of VISIBLE rows on the board. y=12..13 are never rendered. */
export const VISIBLE_ROWS = 12;

export const FIELD_PIXEL_WIDTH = CELL_SIZE * FIELD_COLS; // 288
export const FIELD_PIXEL_HEIGHT = CELL_SIZE * VISIBLE_ROWS; // 576

/**
 * Top-left corner of the field in screen space (solo layout).
 *
 * Picked so the bigger field fits comfortably in the 1280×720 internal
 * stage without overlapping the HUD pinned to the top-right corner.
 * Field right edge sits at 776, leaving ~210px on the right for the
 * NEXT panel (see NextRenderer).
 */
export const FIELD_ORIGIN_X = 488;
export const FIELD_ORIGIN_Y = 72;

/** Per-puyo palette, matching D8 §3.3. */
export const PUYO_COLORS: Record<PuyoColor | 'X', number> = {
  R: 0xff4a6b,
  G: 0x6ce048,
  B: 0x4a9bff,
  Y: 0xffd23a,
  P: 0xc864ff,
  X: 0x9ca3af,
};

/** Radius of a puyo sprite in pixels (slight inset inside the cell). */
export const PUYO_RADIUS = Math.floor(CELL_SIZE / 2 - 2); // 18

/**
 * Convert a board cell (x, y) into the pixel center of its sprite.
 * y is measured with 0 at the BOTTOM of the visible area — matching
 * the board coordinate system in D1 §1.
 */
export function cellCenter(boardX: number, boardY: number): { x: number; y: number } {
  const pixelX = FIELD_ORIGIN_X + boardX * CELL_SIZE + CELL_SIZE / 2;
  const pixelY = FIELD_ORIGIN_Y + (VISIBLE_ROWS - 1 - boardY) * CELL_SIZE + CELL_SIZE / 2;
  return { x: pixelX, y: pixelY };
}

/** Return the pixel color for a `CellKind`. `null` maps to a sentinel 0. */
export function colorFor(kind: CellKind): number | null {
  if (kind === null) return null;
  return PUYO_COLORS[kind];
}
