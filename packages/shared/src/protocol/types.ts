/**
 * Core shared types referenced by both client and server.
 * See D4 §2, D1 §2.
 *
 * This file intentionally exports type-only declarations so that the
 * shared package remains free of runtime dependencies.
 */

export type PlayerId = string;
export type RoomId = string;
export type Frame = number;

export type PuyoColor = 'R' | 'G' | 'B' | 'Y' | 'P';
export type ColorMode = 4 | 5;
export type Capacity = 2 | 3 | 4;

export type InputAction = 'MOVE_L' | 'MOVE_R' | 'ROT_L' | 'ROT_R' | 'SOFT_START' | 'SOFT_END';
