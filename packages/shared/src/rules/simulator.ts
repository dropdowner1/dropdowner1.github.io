/**
 * Frame-driven simulator — the state machine that wires every other
 * module in `rules/` together.
 *
 * The simulator is purely logical: it has no renderer, no input
 * source, and no networking. Callers drive it via `advanceFrame` with
 * per-player input actions each tick. See D2 for the state machine,
 * D1 for board rules, D3 for scoring.
 *
 * The simulator is fully deterministic: given an identical seed,
 * identical initial config, and identical per-frame inputs, the
 * resulting state — and therefore `computeHash` — is byte-for-byte
 * reproducible. This is the property lockstep multiplayer relies on.
 */

import type { ColorMode, InputAction, PlayerId, PuyoColor } from '../protocol/types';
import {
  BOARD_WIDTH,
  type Board,
  type Cell,
  cloneBoard,
  createBoard,
  hashBoard,
  isOjama,
  setCell,
} from './board';
import { type Cluster, findPoppingClusters } from './cluster';
import {
  type PlayerStatus,
  type TargetablePlayer,
  applyOffset,
  convertScoreToGarbage,
  placeOjama,
  selectTarget,
} from './garbage';
import { applyGravityWithFall, hasFloatingCells } from './gravity';
import { type Piece, createPiece, getChildPos } from './piece';
import { Xorshift32 } from './rng';
import { tryMove, tryRotate } from './rotate';
import { calculateChainScore } from './score';
import { trySpawn } from './spawn';

// ---------- Config / timing constants ----------

// Starting natural-fall pace: one cell every 36 frames = 0.6s at 60fps.
// This is the "level 0" speed; `fallIntervalForCleared(cellsCleared)`
// shortens it as the player chews through puyos so the game accelerates
// in the SNES tradition.
export const FALL_INTERVAL_NORMAL = 36;
export const FALL_INTERVAL_SOFT = 2;
/** Floor for the natural-fall interval — the fastest the gauge ever gets. */
export const FALL_INTERVAL_MIN = 6;
/** Puyos cleared between two consecutive speed bumps. */
export const FALL_SPEEDUP_CLEARED_PER_LEVEL = 30;
/** Frames knocked off the natural fall interval per level. */
export const FALL_SPEEDUP_FRAMES_PER_LEVEL = 4;

/**
 * Natural-fall interval (in frames) for the given cumulative cleared
 * count. Floors at `FALL_INTERVAL_MIN` so the game is still readable
 * even after hundreds of pops. Pure function — used by both the
 * simulator and the HUD.
 *
 * `normalInterval` defaults to `FALL_INTERVAL_NORMAL` (普通 difficulty)
 * but accepts a per-match override so the difficulty picker can pick a
 * slower or faster starting pace.
 */
export function fallIntervalForCleared(
  cellsCleared: number,
  normalInterval: number = FALL_INTERVAL_NORMAL,
): number {
  const level = Math.floor(Math.max(0, cellsCleared) / FALL_SPEEDUP_CLEARED_PER_LEVEL);
  return Math.max(FALL_INTERVAL_MIN, normalInterval - level * FALL_SPEEDUP_FRAMES_PER_LEVEL);
}
// 18 frames = 0.3s at 60fps. The grace window between a piece touching
// the ground and locking — gives the player a beat to slide it sideways.
export const LOCK_DELAY_FRAMES = 18;
export const LOCK_RESET_LIMIT = 8;
// Per-cell visual fall time. Mirrors the renderer's FALL_SPEED
// (CELL_SIZE / FALL_FRAMES_PER_CELL px/frame) — keep in sync if
// either is tuned. Lowered from 5 to 3 frames for snappier chigiri
// + post-pop falls; the bounce + chigiri windows scale with this.
export const FALL_FRAMES_PER_CELL = 3;
// Frames to hold after a fall lands so the bounce/squish animation can
// finish before the next chain tick or the next piece spawns.
export const POST_FALL_SETTLE_FRAMES = 5;
// Chigiri (split-drop) phase. The piece sits at its locked position
// for this many frames before gravity is applied; after gravity, the
// phase extends by `maxFall * FALL_FRAMES_PER_CELL + POST_FALL_SETTLE`
// so the visual fall is always allowed to complete before resolving.
// 20-frame hold (≈0.33s) is enough for the eye to register the split
// without the lull feeling sluggish; the old 40-frame value was tuned
// for a slower fall speed.
export const CHIGIRI_FRAMES = 20;
// One chain tick in frames. Pop animation runs from frame 0 to
// POP_FRAMES; gravity fires at POP_FRAMES. The remaining frames cover
// the visible fall — the tick stretches dynamically per
// `applyChainTick`'s reported `maxFall` so that even tall collapses
// finish before the next pop check.
export const RESOLVE_TICK_FRAMES = 60;
// Sub-phase split inside a resolve tick:
//   0..POP_FRAMES-1      pop animation (cells still on the board)
//   at POP_FRAMES        clusters cleared, ojama swept, gravity applied
//   POP_FRAMES..tickEnd  renderer animates the fall + bounce
export const POP_FRAMES = 32;
// 18 frames = 0.3s at 60fps. Always-on breather between resolving and
// the next spawn so the field state is readable.
export const WAIT_GARBAGE_FRAMES = 18;
export const DEAD_FRAMES = 60;
export const COUNTDOWN_FRAMES = 180;

export type PhaseKind =
  | 'spawn'
  | 'falling'
  | 'chigiri'
  | 'resolving'
  | 'waitGarbage'
  | 'dead'
  | 'spectating';

// ---------- Event stream ----------

export type SimulatorEvent =
  | { type: 'spawn'; playerId: PlayerId; piece: Piece }
  | { type: 'lock'; playerId: PlayerId }
  | { type: 'chigiri_start'; playerId: PlayerId }
  | {
      type: 'chain_tick';
      playerId: PlayerId;
      chainIndex: number;
      clusters: readonly Cluster[];
      chainScore: number;
      generated: number;
      offset: number;
      sent: number;
      targetPlayerId: PlayerId | null;
    }
  | {
      type: 'ojama_drop';
      playerId: PlayerId;
      dropped: number;
      destroyed: number;
      carryOver: number;
    }
  | { type: 'death'; playerId: PlayerId }
  | { type: 'match_end'; winnerId: PlayerId | null };

// ---------- Player / match types ----------

interface ResolvingData {
  pendingClusters: readonly Cluster[];
  tickFrame: number;
  /** Set once `applyChainTick` has committed this tick's board changes. */
  applied?: boolean;
  /**
   * Effective end frame for this tick. Computed at apply-time from the
   * gravity result so a long fall stretches the tick instead of having
   * the next pop fire while puyos are still mid-air.
   */
  tickEndFrame?: number;
}

interface ChigiriData {
  /** Whether gravity has already been applied this chigiri. */
  applied: boolean;
  /** End frame for the entire chigiri phase, including post-fall settle. */
  endFrame: number;
}

export interface PlayerState {
  readonly id: PlayerId;
  readonly slotIndex: number;
  status: PlayerStatus;
  phase: PhaseKind;
  phaseFrame: number;
  board: Board;
  current: Piece | null;
  dropQueueIndex: number;
  // Scoring / garbage accounting
  score: number;
  leftoverScore: number;
  pendingGarbage: number;
  sentGarbage: number;
  chainCount: number;
  maxChain: number;
  /**
   * Total normal-color cells cleared by this player across the whole
   * match. Drives the "ぷよ消し総数" HUD and the progressive fall-speed
   * curve (see `fallIntervalForCleared`). Ojama is NOT counted here —
   * only the cells that came in via popping clusters.
   */
  cellsCleared: number;
  // Falling-phase transient state
  fallTimer: number;
  lockTimer: number;
  lockResets: number;
  softDrop: boolean;
  // Resolving-phase transient state
  resolvingData: ResolvingData | null;
  // Chigiri-phase transient state
  chigiriData: ChigiriData | null;
}

// Structural check: PlayerState must satisfy TargetablePlayer so that
// `selectTarget` accepts it. The assignment below exists purely to
// surface a compile error if the two interfaces drift apart.
const _targetablePlayerCheck = (p: PlayerState): TargetablePlayer => p;
void _targetablePlayerCheck;

export interface MatchState {
  frame: number;
  status: 'countdown' | 'running' | 'finished';
  countdownTimer: number;
  players: PlayerState[];
  dropQueue: readonly (readonly [PuyoColor, PuyoColor])[];
  colorMode: ColorMode;
  rng: Xorshift32;
  winnerId: PlayerId | null;
  /** Events produced during the most recent `advanceFrame` call. */
  events: SimulatorEvent[];
  /**
   * Starting natural-fall interval (frames per cell). Overrides
   * `FALL_INTERVAL_NORMAL` for difficulty selection — solo play picks
   * this when the player chooses 激甘 / 甘口 / 普通 / 中辛 / 辛口 / 激辛.
   * The progressive speed-up in `fallIntervalForCleared` is applied on
   * top of whichever starting value is set.
   */
  fallIntervalNormal: number;
}

export interface PlayerInit {
  id: PlayerId;
  slotIndex?: number;
}

export interface MatchConfig {
  seed: number;
  colorMode: ColorMode;
  players: readonly PlayerInit[];
  dropQueueLength?: number;
  startWithCountdown?: boolean;
  /**
   * Starting natural-fall interval (frames per cell). Defaults to
   * `FALL_INTERVAL_NORMAL` (= 普通) when omitted; the solo difficulty
   * picker passes 12..72 to cover 激甘..激辛.
   */
  fallIntervalNormal?: number;
}

// ---------- Drop queue generation ----------

/**
 * Generate a deterministic list of (axis, child) colour pairs.
 *
 * The first two pairs are restricted to three distinct colours to
 * tame first-move luck per D1 §3.3. `colorCount` selects the palette:
 *   4 → { R, G, B, Y }
 *   5 → { R, G, B, Y, P }
 */
export function generateDropQueue(
  seed: number,
  count: number,
  colorCount: ColorMode,
): [PuyoColor, PuyoColor][] {
  if (count < 0 || !Number.isInteger(count)) {
    throw new RangeError(`generateDropQueue: bad count ${count}`);
  }
  const fullPool: PuyoColor[] = colorCount === 4 ? ['R', 'G', 'B', 'Y'] : ['R', 'G', 'B', 'Y', 'P'];
  const initialPool: PuyoColor[] = ['R', 'G', 'B'];
  const rng = new Xorshift32(seed);

  const result: [PuyoColor, PuyoColor][] = [];
  for (let i = 0; i < count; i++) {
    const pool = i < 2 ? initialPool : fullPool;
    const axis = pool[rng.nextInt(pool.length)] as PuyoColor;
    const child = pool[rng.nextInt(pool.length)] as PuyoColor;
    result.push([axis, child]);
  }
  return result;
}

// ---------- Factory ----------

export function createMatchState(config: MatchConfig): MatchState {
  if (config.players.length === 0) {
    throw new Error('createMatchState: at least one player is required');
  }
  const dropQueueLength = config.dropQueueLength ?? 1024;
  const dropQueue = generateDropQueue(config.seed, dropQueueLength, config.colorMode);
  const rng = new Xorshift32(config.seed ^ 0x9e3779b9);

  const players: PlayerState[] = config.players.map((init, i) => ({
    id: init.id,
    slotIndex: init.slotIndex ?? i,
    status: 'playing',
    phase: 'spawn',
    phaseFrame: 0,
    board: createBoard(),
    current: null,
    dropQueueIndex: 0,
    score: 0,
    leftoverScore: 0,
    pendingGarbage: 0,
    sentGarbage: 0,
    chainCount: 0,
    maxChain: 0,
    cellsCleared: 0,
    fallTimer: 0,
    lockTimer: 0,
    lockResets: 0,
    softDrop: false,
    resolvingData: null,
    chigiriData: null,
  }));

  const startWithCountdown = config.startWithCountdown ?? false;

  return {
    frame: 0,
    status: startWithCountdown ? 'countdown' : 'running',
    countdownTimer: startWithCountdown ? COUNTDOWN_FRAMES : 0,
    players,
    dropQueue,
    colorMode: config.colorMode,
    rng,
    winnerId: null,
    events: [],
    fallIntervalNormal: config.fallIntervalNormal ?? FALL_INTERVAL_NORMAL,
  };
}

// ---------- Main tick ----------

/**
 * Advance the simulation by exactly one frame.
 *
 * `inputs` maps playerId → ordered list of input actions to apply
 * during this frame. Missing keys mean "no input this frame".
 *
 * Mutates `match` in place. Clears and repopulates `match.events`.
 */
export function advanceFrame(
  match: MatchState,
  inputs: Record<PlayerId, readonly InputAction[]> = {},
): void {
  match.events = [];
  match.frame++;

  if (match.status === 'finished') return;

  if (match.status === 'countdown') {
    match.countdownTimer--;
    if (match.countdownTimer <= 0) {
      match.status = 'running';
    }
    return;
  }

  // status === 'running': sort players by slotIndex for deterministic processing.
  const ordered = [...match.players].sort((a, b) => a.slotIndex - b.slotIndex);
  for (const player of ordered) {
    const actions = inputs[player.id] ?? [];
    processPlayer(match, player, actions);
  }

  checkMatchEnd(match);
}

// ---------- Per-player phase dispatch ----------

function processPlayer(
  match: MatchState,
  player: PlayerState,
  actions: readonly InputAction[],
): void {
  // SOFT_START / SOFT_END track a held-key state, not a per-frame
  // action. They must be honored regardless of phase so that releasing
  // ↓ during a chain (or between pieces) is not swallowed and the
  // next piece doesn't inherit a stale fast-fall flag.
  // See bug: post-chain piece falls too fast when ↓ was released
  // while not in the `falling` phase.
  for (const action of actions) {
    if (action === 'SOFT_START') player.softDrop = true;
    else if (action === 'SOFT_END') player.softDrop = false;
  }

  switch (player.phase) {
    case 'spawn':
      handleSpawn(match, player);
      break;
    case 'falling':
      handleFalling(match, player, actions);
      break;
    case 'chigiri':
      handleChigiri(match, player);
      break;
    case 'resolving':
      handleResolving(match, player);
      break;
    case 'waitGarbage':
      handleWaitGarbage(match, player);
      break;
    case 'dead':
      handleDead(match, player);
      break;
    case 'spectating':
      // no-op
      break;
  }
}

// ---------- spawn (1f) ----------

function handleSpawn(match: MatchState, player: PlayerState): void {
  const spawnResult = trySpawn(player.board);
  if (spawnResult === 'DEATH') {
    enterDead(match, player);
    return;
  }

  const pair = match.dropQueue[player.dropQueueIndex] ?? null;
  const colors: [PuyoColor, PuyoColor] = pair
    ? [pair[0] as PuyoColor, pair[1] as PuyoColor]
    : // Shouldn't happen in practice (queue is generated long), but
      // fall back defensively.
      ['R', 'R'];

  const piece = createPiece(colors);
  player.current = piece;
  player.dropQueueIndex++;
  player.phase = 'falling';
  player.phaseFrame = 0;
  player.fallTimer = 0;
  player.lockTimer = 0;
  player.lockResets = 0;

  match.events.push({ type: 'spawn', playerId: player.id, piece });
}

// ---------- falling (variable) ----------

function handleFalling(
  match: MatchState,
  player: PlayerState,
  actions: readonly InputAction[],
): void {
  if (!player.current) {
    // Guard: should have a current piece when in 'falling'.
    player.phase = 'spawn';
    player.phaseFrame = 0;
    return;
  }

  // 1. Inputs (order preserved; side effects on player.current and timers).
  for (const action of actions) applyAction(player, action);

  // 2. Gravity.
  const fallInterval = player.softDrop
    ? FALL_INTERVAL_SOFT
    : fallIntervalForCleared(player.cellsCleared, match.fallIntervalNormal);
  player.fallTimer++;
  if (player.fallTimer >= fallInterval) {
    const down = tryMove(player.board, player.current, 0, -1);
    if (down) {
      player.current = down;
    }
    player.fallTimer = 0;
  }

  // 3. Ground check + lock timer.
  const grounded = tryMove(player.board, player.current, 0, -1) === null;
  if (grounded) {
    player.lockTimer++;
    if (player.lockTimer >= LOCK_DELAY_FRAMES || player.lockResets >= LOCK_RESET_LIMIT) {
      onLock(match, player);
      return;
    }
  } else {
    player.lockTimer = 0;
  }
  player.phaseFrame++;
}

function applyAction(player: PlayerState, action: InputAction): void {
  if (!player.current) return;
  switch (action) {
    case 'MOVE_L': {
      const next = tryMove(player.board, player.current, -1, 0);
      if (next) onInputSuccess(player, next);
      break;
    }
    case 'MOVE_R': {
      const next = tryMove(player.board, player.current, 1, 0);
      if (next) onInputSuccess(player, next);
      break;
    }
    case 'ROT_L': {
      const next = tryRotate(player.board, player.current, 'CCW');
      if (next) onInputSuccess(player, next);
      break;
    }
    case 'ROT_R': {
      const next = tryRotate(player.board, player.current, 'CW');
      if (next) onInputSuccess(player, next);
      break;
    }
    // SOFT_START / SOFT_END are handled in processPlayer before the phase
    // switch so that key-up events survive phase transitions.
    case 'SOFT_START':
      break;
    case 'SOFT_END':
      break;
  }
}

function onInputSuccess(player: PlayerState, next: Piece): void {
  player.current = next;
  const grounded = tryMove(player.board, next, 0, -1) === null;
  if (grounded) {
    player.lockTimer = 0;
    player.lockResets++;
  }
}

function onLock(match: MatchState, player: PlayerState): void {
  const piece = player.current;
  if (!piece) return;
  setCell(player.board, piece.axisX, piece.axisY, piece.colors[0]);
  const [cx, cy] = getChildPos(piece);
  setCell(player.board, cx, cy, piece.colors[1]);
  player.current = null;

  match.events.push({ type: 'lock', playerId: player.id });

  if (hasFloatingCells(player.board)) {
    // Defer gravity until the END of chigiri so the renderer can see
    // the cells at their LOCKED positions and animate the visible
    // fall. Without this delay the cells teleport to their final
    // positions in one frame.
    player.phase = 'chigiri';
    player.phaseFrame = 0;
    match.events.push({ type: 'chigiri_start', playerId: player.id });
  } else {
    enterResolving(player);
  }
}

// ---------- chigiri ----------

function handleChigiri(_match: MatchState, player: PlayerState): void {
  player.phaseFrame++;
  if (!player.chigiriData) {
    if (player.phaseFrame < CHIGIRI_FRAMES) return;
    // First, commit gravity. Track the longest fall so the phase can
    // be extended just enough for the visual fall to land before we
    // hand off to resolving — without this, the next tick (or next
    // spawn, when no chain follows) starts while puyos are mid-air.
    const { maxFall } = applyGravityWithFall(player.board);
    player.chigiriData = {
      applied: true,
      endFrame: player.phaseFrame + maxFall * FALL_FRAMES_PER_CELL + POST_FALL_SETTLE_FRAMES,
    };
  }
  if (player.phaseFrame >= player.chigiriData.endFrame) {
    enterResolving(player);
  }
}

function enterResolving(player: PlayerState): void {
  player.phase = 'resolving';
  player.phaseFrame = 0;
  player.chainCount = 0;
  player.resolvingData = null;
  player.chigiriData = null;
}

// ---------- resolving ----------

function handleResolving(match: MatchState, player: PlayerState): void {
  if (!player.resolvingData) {
    const clusters = findPoppingClusters(player.board);
    if (clusters.length === 0) {
      // Consume this frame as the "final check" and transition.
      player.phase = 'waitGarbage';
      player.phaseFrame = 0;
      return;
    }
    player.resolvingData = { pendingClusters: clusters, tickFrame: 0 };
  }

  const data = player.resolvingData;
  data.tickFrame++;
  // Apply the logical tick (clear + gravity + score) at POP_FRAMES so
  // the renderer spends the rest of the tick animating the fall.
  if (data.tickFrame === POP_FRAMES && !data.applied) {
    const maxFall = applyChainTick(match, player, data.pendingClusters);
    data.applied = true;
    // Stretch this tick so the next pop can't fire until the longest
    // fall has visually landed and bounced.
    data.tickEndFrame = Math.max(
      RESOLVE_TICK_FRAMES,
      POP_FRAMES + maxFall * FALL_FRAMES_PER_CELL + POST_FALL_SETTLE_FRAMES,
    );
  }
  const tickEnd = data.tickEndFrame ?? RESOLVE_TICK_FRAMES;
  if (data.tickFrame < tickEnd) return;

  // Safety net: make sure the tick has been applied even if constants
  // were changed to equal values.
  if (!data.applied) {
    applyChainTick(match, player, data.pendingClusters);
  }
  player.resolvingData = null;
}

function applyChainTick(
  match: MatchState,
  player: PlayerState,
  clusters: readonly Cluster[],
): number {
  // 1. Sweep ojama adjacent to popping cells (visible area only).
  const ojamaToClear = new Set<number>();
  for (const cluster of clusters) {
    for (const cell of cluster.cells) {
      for (const [nx, ny] of neighbors4(cell.x, cell.y)) {
        if (!isVisibleCell(nx, ny)) continue;
        const row = player.board.cells[ny] as Cell[];
        const nCell = row[nx] as Cell;
        if (isOjama(nCell.kind)) ojamaToClear.add(ny * BOARD_WIDTH + nx);
      }
    }
  }

  // 2. Clear cluster cells + swept ojama.
  let clearedThisTick = 0;
  for (const cluster of clusters) {
    for (const { x, y } of cluster.cells) {
      setCell(player.board, x, y, null);
      clearedThisTick++;
    }
  }
  player.cellsCleared += clearedThisTick;
  for (const key of ojamaToClear) {
    const y = Math.floor(key / BOARD_WIDTH);
    const x = key % BOARD_WIDTH;
    setCell(player.board, x, y, null);
  }

  // 3. Gravity. Track the longest fall so the caller can stretch the
  //    tick window to cover the visible fall animation.
  const { maxFall } = applyGravityWithFall(player.board);

  // 4. Chain counter.
  player.chainCount++;
  if (player.chainCount > player.maxChain) player.maxChain = player.chainCount;

  // 5. Score + garbage conversion.
  const chainScore = calculateChainScore(player.chainCount, clusters);
  player.score += chainScore;

  const conv = convertScoreToGarbage(player.leftoverScore, chainScore);
  player.leftoverScore = conv.newLeftover;

  const off = applyOffset(player.pendingGarbage, conv.generated);
  player.pendingGarbage = off.remainingPending;

  let sent = 0;
  let targetId: PlayerId | null = null;
  if (off.remainingGenerated > 0) {
    const target = selectTarget(player, match.players);
    if (target) {
      target.pendingGarbage += off.remainingGenerated;
      player.sentGarbage += off.remainingGenerated;
      sent = off.remainingGenerated;
      targetId = target.id;
    }
  }

  match.events.push({
    type: 'chain_tick',
    playerId: player.id,
    chainIndex: player.chainCount,
    clusters,
    chainScore,
    generated: conv.generated,
    offset: off.offset,
    sent,
    targetPlayerId: targetId,
  });

  return maxFall;
}

function neighbors4(x: number, y: number): readonly [number, number][] {
  return [
    [x + 1, y],
    [x - 1, y],
    [x, y + 1],
    [x, y - 1],
  ];
}

function isVisibleCell(x: number, y: number): boolean {
  return x >= 0 && x < 6 && y >= 0 && y < 12;
}

// ---------- waitGarbage ----------

function handleWaitGarbage(match: MatchState, player: PlayerState): void {
  if (player.phaseFrame === 0 && player.pendingGarbage > 0) {
    const result = placeOjama(player.board, player.pendingGarbage, match.rng);
    player.pendingGarbage = result.carryOver;
    match.events.push({
      type: 'ojama_drop',
      playerId: player.id,
      dropped: result.dropped,
      destroyed: result.destroyed,
      carryOver: result.carryOver,
    });
  }
  // Always run the full wait period — even with no incoming garbage —
  // so there is a 0.3s breather before the next piece spawns.
  player.phaseFrame++;
  if (player.phaseFrame >= WAIT_GARBAGE_FRAMES) {
    player.phase = 'spawn';
    player.phaseFrame = 0;
  }
}

// ---------- dead / spectating ----------

function enterDead(match: MatchState, player: PlayerState): void {
  player.status = 'dead';
  player.phase = 'dead';
  player.phaseFrame = 0;
  player.current = null;
  match.events.push({ type: 'death', playerId: player.id });
}

function handleDead(_match: MatchState, player: PlayerState): void {
  player.phaseFrame++;
  if (player.phaseFrame >= DEAD_FRAMES) {
    player.phase = 'spectating';
    player.status = 'spectating';
    player.phaseFrame = 0;
  }
}

// ---------- Match end ----------

function checkMatchEnd(match: MatchState): void {
  const alive = match.players.filter((p) => p.status === 'playing');
  if (match.players.length === 1) {
    // Solo: end on death.
    if (alive.length === 0) {
      match.status = 'finished';
      match.winnerId = null;
      match.events.push({ type: 'match_end', winnerId: null });
    }
    return;
  }
  if (alive.length <= 1) {
    match.status = 'finished';
    match.winnerId = alive[0]?.id ?? null;
    match.events.push({ type: 'match_end', winnerId: match.winnerId });
  }
}

// ---------- Desync hash ----------

/**
 * Deterministic hash of the entire match state, suitable for lockstep
 * desync detection. Covers each player's board, score, pending, and
 * phase, plus match frame / status / winner / rng state.
 */
export function computeHash(match: MatchState): string {
  let h = 0x811c9dc5;
  const push = (n: number) => {
    h ^= n >>> 0;
    h = (Math.imul(h, 0x01000193) >>> 0) | 0;
  };

  push(match.frame);
  push(match.status === 'running' ? 1 : match.status === 'countdown' ? 2 : 3);
  push(match.rng.getState());

  for (const p of match.players) {
    push(hashBoard(p.board));
    push(p.score);
    push(p.pendingGarbage);
    push(p.leftoverScore);
    push(p.sentGarbage);
    push(p.chainCount);
    push(phaseToCode(p.phase));
    push(p.phaseFrame);
    push(p.dropQueueIndex);
    // Fold current-piece position into the hash so that differences
    // during falling (which don't touch the board yet) are visible.
    if (p.current) {
      push(p.current.axisX);
      push(p.current.axisY);
      push(p.current.rotation);
    } else {
      push(0xdead);
    }
  }

  return (h >>> 0).toString(16).padStart(8, '0');
}

function phaseToCode(phase: PhaseKind): number {
  switch (phase) {
    case 'spawn':
      return 1;
    case 'falling':
      return 2;
    case 'chigiri':
      return 3;
    case 'resolving':
      return 4;
    case 'waitGarbage':
      return 5;
    case 'dead':
      return 6;
    case 'spectating':
      return 7;
  }
}

// ---------- Utility (testing/debug) ----------

/**
 * Return a cheap structural snapshot of a player — useful in tests.
 * The board is deep-copied so the caller can compare without worrying
 * about later mutation.
 */
export function snapshotPlayer(player: PlayerState): {
  phase: PhaseKind;
  score: number;
  pending: number;
  chainCount: number;
  board: Board;
} {
  return {
    phase: player.phase,
    score: player.score,
    pending: player.pendingGarbage,
    chainCount: player.chainCount,
    board: cloneBoard(player.board),
  };
}
