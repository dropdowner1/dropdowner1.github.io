/**
 * Pixi-backed field renderer.
 *
 * Visual responsibilities:
 *   - Field frame + grid (drawn once).
 *   - Puyo sprites from the sprite sheet (see `PuyoTexture`). Connection
 *     info picks the right sheet row so same-color neighbours visually
 *     fuse like the original.
 *   - Rotation animation: the child puyo traces a circular arc around
 *     the axis; wall kicks also slide the axis in parallel.
 *   - Horizontal move + natural fall: SNAP to grid.
 *   - Soft drop: smoothed toward target so the slide reads as fluid.
 *   - Gravity fall animation after chain ticks: uniform pixels-per-frame
 *     speed with a gummy bounce when a cell lands.
 *   - Pop animation: grow, fade, rapid-blink during the pop window.
 *   - Burst particles radiate outward when a puyo is cleared.
 *   - Occasional eye blinks on settled puyos (sprite squash).
 */

import { FALL_FRAMES_PER_CELL, FALL_INTERVAL_SOFT, type PlayerState } from '@chaindrop/shared';
import { Container, Graphics, Sprite, type Texture } from 'pixi.js';
import type { PuyoSheet } from './PuyoTexture';
import { SHEET_CELL } from './PuyoTexture';
import { type FieldSprite, computeFieldSprites } from './fieldView';
import {
  CELL_SIZE,
  FIELD_COLS,
  FIELD_ORIGIN_X,
  FIELD_ORIGIN_Y,
  FIELD_PIXEL_HEIGHT,
  FIELD_PIXEL_WIDTH,
  VISIBLE_ROWS,
} from './layout';

const FRAME_LINE_COLOR = 0xffd60a;
const GRID_LINE_COLOR = 0x2a2a44;

/** Target sprite size / texture cell size. Applied as the base scale. */
const BASE_SCALE = CELL_SIZE / SHEET_CELL; // 48 / 32 = 1.5

/** Rotation arc duration in render frames. */
const ROTATION_FRAMES = 6;
/**
 * Soft-drop visual descent — constant pixels per render frame, matching
 * the simulator's `FALL_INTERVAL_SOFT` (one cell every N frames). Using a
 * linear step rather than the previous exponential lerp keeps perceived
 * velocity constant the moment the key is held, so it doesn't feel like
 * the piece accelerates from rest.
 */
const SOFT_DROP_STEP = CELL_SIZE / FALL_INTERVAL_SOFT;
/**
 * Gravity-fall speed in pixels per render frame (uniform across columns).
 * Stays in sync with the simulator's `FALL_FRAMES_PER_CELL` so that the
 * resolve / chigiri tick windows correctly cover the visible fall.
 */
const FALL_SPEED = CELL_SIZE / FALL_FRAMES_PER_CELL;
/**
 * Duration of the post-fall gummy bounce, in render frames. A longer
 * window with a softer scale gives the impact a "mochi" squish — slow
 * push down, then easing back — instead of a sharp pop.
 */
const BOUNCE_FRAMES = 14;
/** Average frames between idle-blink attempts per puyo. */
const IDLE_BLINK_AVG_INTERVAL = 240; // ~4s at 60fps
/** How long one idle blink lasts. */
const IDLE_BLINK_FRAMES = 8;
/** Eyelid color (a slightly darker grey on the puyo body). */
const EYELID_COLOR = 0x1a1a1a;
/** Eye geometry in screen pixels, relative to the sprite center. */
const EYE_OFFSET_X = 6.5;
const EYE_OFFSET_Y = -5;
const EYE_W = 7;
const EYE_H = 3;
/** Average frames between look-around events per puyo. */
const LOOK_AVG_INTERVAL = 720; // ~12s
/** How long one look-around glance lasts. */
const LOOK_FRAMES = 28;

/**
 * Screen-space angle (radians) the child sits at for each rotation.
 *   rotation 0 (child BELOW)  → π/2
 *   rotation 1 (child LEFT)   → π
 *   rotation 2 (child ABOVE)  → 3π/2
 *   rotation 3 (child RIGHT)  → 0
 */
const ANGLE_BY_ROTATION: readonly number[] = [Math.PI / 2, Math.PI, (3 * Math.PI) / 2, 0];

interface PieceAnim {
  currentAngle: number;
  displayAxisX: number;
  displayAxisY: number;
  targetAngle: number;
  targetAxisX: number;
  targetAxisY: number;
  rotProgress: number;
  lastRotation: number;
}

interface CellSnapshot {
  kind: string;
  /** Displayed y in pixels right now (includes any in-progress fall). */
  displayY: number;
  /** Target y in pixels (where it should settle). */
  targetY: number;
  /** True while the fall animation is still moving. */
  falling: boolean;
  /**
   * True when the cell is currently in its pop animation. Needed so the
   * very next frame — when the simulator has already cleared the cluster
   * AND a same-color puyo has fallen from above into this exact (x, y) —
   * we recognise that the sprite that "matches by id" is actually a
   * brand-new arrival and recreate it so the fall animates properly.
   * Without this flag, the renderer reuses the popping sprite for the
   * fall-in and the new puyo appears to teleport down.
   */
  popping: boolean;
  /** Gummy-bounce frame counter: -1 means inactive, 0..BOUNCE_FRAMES-1 active. */
  bounceFrame: number;
  /** Frames left in an idle blink (0 = not blinking). */
  blinkFrames: number;
  /**
   * Whether this idle event closes both eyes (false) or one eye only
   * (true → wink). Random per event. Wink gets the LEFT eye when true.
   */
  blinkIsWink: boolean;
  /** Which eye to wink, when blinkIsWink: 'L' or 'R'. */
  winkEye: 'L' | 'R';
  /** Frames until next idle-blink attempt. */
  nextBlinkIn: number;
  /** Look-around: 0 = idle, otherwise frames left in current glance. */
  lookFrames: number;
  /** Direction the eyes are looking when lookFrames > 0. */
  lookDir: -1 | 0 | 1; // -1 = left, 0 = up/down (mixed), 1 = right
  /** Vertical look offset (-1 up, 0 neutral, 1 down). */
  lookDirY: -1 | 0 | 1;
  /** Frames until the next look-around attempt. */
  nextLookIn: number;
}

interface BoardEntry {
  /** Container holding sprite + eye overlays so they share a transform. */
  container: Container;
  sprite: Sprite;
  leftEyelid: Graphics;
  rightEyelid: Graphics;
  snap: CellSnapshot;
}

/** One-shot radiating particle used for a pop burst. */
interface Particle {
  graphic: Graphics;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
}

export class FieldRenderer {
  readonly container: Container;
  private frameLayer: Graphics;
  private spriteLayer: Container;
  private burstLayer: Container;

  private boardSprites = new Map<string, BoardEntry>();
  private pieceSprites = new Map<string, Sprite>();
  private pieceAnim: PieceAnim | null = null;
  private particles: Particle[] = [];

  constructor(private sheet: PuyoSheet) {
    this.container = new Container();
    this.frameLayer = new Graphics();
    this.spriteLayer = new Container();
    this.burstLayer = new Container();
    this.container.addChild(this.frameLayer);
    this.container.addChild(this.spriteLayer);
    this.container.addChild(this.burstLayer);
    this.drawFrame();
  }

  update(player: PlayerState): void {
    const specs = computeFieldSprites(player);
    this.updateBoardSprites(specs.filter((s) => s.kind === 'board'));
    this.updatePieceSprites(
      specs.filter((s) => s.kind === 'axis' || s.kind === 'child'),
      player,
    );
    this.tickParticles();
  }

  destroy(): void {
    for (const entry of this.boardSprites.values()) {
      entry.container.destroy({ children: true });
    }
    for (const s of this.pieceSprites.values()) s.destroy();
    for (const p of this.particles) p.graphic.destroy();
    this.boardSprites.clear();
    this.pieceSprites.clear();
    this.particles = [];
    this.burstLayer.destroy({ children: true });
    this.spriteLayer.destroy({ children: true });
    this.frameLayer.destroy();
    this.container.destroy({ children: true });
  }

  // ----------------------------------------------------------------
  // Board cells
  // ----------------------------------------------------------------

  private updateBoardSprites(specs: FieldSprite[]): void {
    const seen = new Set<string>();

    for (const spec of specs) {
      seen.add(spec.id);
      const existing = this.boardSprites.get(spec.id);
      // A sprite that was popping last frame can collide with a brand
      // new arrival from above: same (x, y), same colour, but a
      // different physical cell. If we naively `updateExisting` here,
      // the new puyo silently inherits the popping sprite's state and
      // appears to teleport down. Treat that case as a recreate so the
      // fall animation starts from the source above.
      const wasPopping = !!existing && existing.snap.popping;
      const stalePop = wasPopping && (spec.popProgress === undefined || spec.popProgress >= 1);
      if (existing && existing.snap.kind === spec.cellKind && !stalePop) {
        this.updateExistingBoardSprite(existing, spec);
      } else {
        if (existing) {
          // Existing sprite is either a different colour (unusual; gravity
          // never swaps colours) or a freshly-cleared popping cell. Burst
          // out the popping cell so the visual "clear" still reads.
          if (stalePop) {
            this.emitBurst(
              existing.container.x,
              existing.snap.displayY,
              this.getTintForKind(existing.snap.kind),
            );
          }
          this.spriteLayer.removeChild(existing.container);
          existing.container.destroy({ children: true });
          this.boardSprites.delete(spec.id);
        }
        const entry = this.createBoardSprite(spec);
        this.boardSprites.set(spec.id, entry);
        this.spriteLayer.addChild(entry.container);
      }
    }

    // Reap cells that vanished. Emit a pop burst at each one so the
    // clear has a satisfying punctuation.
    for (const [id, entry] of this.boardSprites) {
      if (!seen.has(id)) {
        this.emitBurst(
          entry.container.x,
          entry.snap.displayY,
          this.getTintForKind(entry.snap.kind),
        );
        this.spriteLayer.removeChild(entry.container);
        entry.container.destroy({ children: true });
        this.boardSprites.delete(id);
      }
    }
  }

  private createBoardSprite(spec: FieldSprite): BoardEntry {
    const container = new Container();
    const leftEyelid = makeEyelid();
    leftEyelid.x = -EYE_OFFSET_X;
    leftEyelid.y = EYE_OFFSET_Y;
    leftEyelid.visible = false;
    const rightEyelid = makeEyelid();
    rightEyelid.x = EYE_OFFSET_X;
    rightEyelid.y = EYE_OFFSET_Y;
    rightEyelid.visible = false;

    container.x = spec.x;

    let fallFromY = spec.y;
    let falling = false;
    const sourceId = this.findFallSource(spec);
    if (sourceId) {
      const source = this.boardSprites.get(sourceId);
      if (source) {
        fallFromY = source.snap.displayY;
        falling = fallFromY < spec.y;
        this.spriteLayer.removeChild(source.container);
        source.container.destroy({ children: true });
        this.boardSprites.delete(sourceId);
      }
    }

    // While airborne — and during the post-landing bounce squish — the
    // body must read as detached. Use the no-connection texture for the
    // entire fall+bounce window; the settled connection-aware texture
    // is swapped in by `updateExistingBoardSprite` only after the
    // bounce frame counter has reset.
    const sprite = makeSprite(
      this.sheet.get(spec.cellKind, falling ? undefined : spec.connections),
    );
    container.addChild(sprite);
    container.addChild(leftEyelid);
    container.addChild(rightEyelid);

    container.y = fallFromY;
    const snap: CellSnapshot = {
      kind: spec.cellKind,
      displayY: fallFromY,
      targetY: spec.y,
      falling,
      popping: false,
      bounceFrame: -1,
      blinkFrames: 0,
      blinkIsWink: false,
      winkEye: 'L',
      nextBlinkIn: randomDelay(IDLE_BLINK_AVG_INTERVAL),
      lookFrames: 0,
      lookDir: 0,
      lookDirY: 0,
      nextLookIn: randomDelay(LOOK_AVG_INTERVAL),
    };
    const entry: BoardEntry = { container, sprite, leftEyelid, rightEyelid, snap };
    this.applyVisualState(entry, spec);
    return entry;
  }

  private updateExistingBoardSprite(entry: BoardEntry, spec: FieldSprite): void {
    entry.container.x = spec.x;
    if (entry.snap.targetY !== spec.y) {
      entry.snap.targetY = spec.y;
      entry.snap.falling = entry.snap.displayY < spec.y;
      entry.snap.bounceFrame = -1;
      // Drop to a no-connection texture when a new fall starts. The
      // body should look unattached for the whole fall AND the
      // post-landing mochi bounce; only after the bounce settles does
      // the cell click into its neighbours.
      if (entry.snap.falling) {
        entry.sprite.texture = this.sheet.get(spec.cellKind);
      }
    }
    this.tickFall(entry);
    // Adopt the connection-aware texture only once both the fall AND
    // the bounce squish have finished. `tickFall` keeps `bounceFrame`
    // in [0, BOUNCE_FRAMES) during the squish and resets it to -1 once
    // the bounce settles — so `bounceFrame < 0 && !falling` means the
    // puyo is fully at rest, the right moment to fuse with neighbours.
    if (!entry.snap.falling && entry.snap.bounceFrame < 0) {
      entry.sprite.texture = this.sheet.get(spec.cellKind, spec.connections);
    }
    this.tickIdleBlink(entry);
    this.tickLookAround(entry);
    this.applyVisualState(entry, spec);
  }

  /** Uniform-speed fall with a gummy bounce on impact. */
  private tickFall(entry: BoardEntry): void {
    const { snap } = entry;
    if (snap.falling) {
      snap.displayY = Math.min(snap.targetY, snap.displayY + FALL_SPEED);
      if (snap.displayY >= snap.targetY) {
        snap.displayY = snap.targetY;
        snap.falling = false;
        snap.bounceFrame = 0;
      }
    }
    entry.container.y = snap.displayY;

    if (snap.bounceFrame >= 0 && snap.bounceFrame < BOUNCE_FRAMES) {
      snap.bounceFrame += 1;
    } else if (snap.bounceFrame >= BOUNCE_FRAMES) {
      snap.bounceFrame = -1;
    }
  }

  private tickIdleBlink(entry: BoardEntry): void {
    const { snap } = entry;
    if (snap.blinkFrames > 0) {
      snap.blinkFrames -= 1;
      return;
    }
    if (snap.falling || snap.bounceFrame >= 0) return;
    snap.nextBlinkIn -= 1;
    if (snap.nextBlinkIn <= 0) {
      snap.blinkFrames = IDLE_BLINK_FRAMES;
      // 35% of idle events are a one-eyed wink, 65% a regular blink.
      snap.blinkIsWink = Math.random() < 0.35;
      snap.winkEye = Math.random() < 0.5 ? 'L' : 'R';
      snap.nextBlinkIn = randomDelay(IDLE_BLINK_AVG_INTERVAL);
    }
  }

  private tickLookAround(entry: BoardEntry): void {
    const { snap } = entry;
    if (snap.lookFrames > 0) {
      snap.lookFrames -= 1;
      return;
    }
    if (snap.falling || snap.bounceFrame >= 0 || snap.blinkFrames > 0) return;
    snap.nextLookIn -= 1;
    if (snap.nextLookIn <= 0) {
      snap.lookFrames = LOOK_FRAMES;
      // Random of 4 cardinal directions.
      const r = Math.floor(Math.random() * 4);
      switch (r) {
        case 0:
          snap.lookDir = -1;
          snap.lookDirY = 0;
          break;
        case 1:
          snap.lookDir = 1;
          snap.lookDirY = 0;
          break;
        case 2:
          snap.lookDir = 0;
          snap.lookDirY = -1;
          break;
        case 3:
          snap.lookDir = 0;
          snap.lookDirY = 1;
          break;
      }
      snap.nextLookIn = randomDelay(LOOK_AVG_INTERVAL);
    }
  }

  /**
   * Per-frame visual state. Updates body scale (for pop/bounce),
   * alpha (for pop translucency), and eye overlays (for blink/wink/
   * look-around).
   */
  private applyVisualState(entry: BoardEntry, spec: FieldSprite): void {
    const s = entry.sprite;
    let scaleX = BASE_SCALE;
    let scaleY = BASE_SCALE;
    let alpha = 1;

    // Pop: longer-lasting transparency + rapid blink between visible
    // and dim, then a final fade-out at the very end.
    entry.snap.popping = spec.popProgress !== undefined && spec.popProgress > 0;
    if (spec.popProgress !== undefined && spec.popProgress > 0) {
      const p = Math.min(1, spec.popProgress);
      // Subtle scale pulse — much smaller than before so the puyo
      // mostly stays in place while it flickers and fades.
      const popScale = p < 0.5 ? 1 + p * 0.15 : Math.max(0, 1.075 - (p - 0.5) * 1.6);
      scaleX *= popScale;
      scaleY *= popScale;
      // Base translucency throughout the pop (≥ ~0.5 visible).
      let popAlpha = 0.55;
      // Rapid blink: dim phase reaches ~15% alpha.
      const blinkPhase = Math.floor((p * 30) % 2);
      if (blinkPhase === 1) popAlpha = 0.15;
      // Final fade to invisible in the last 25% of the pop.
      if (p > 0.75) popAlpha *= 1 - (p - 0.75) / 0.25;
      alpha *= popAlpha;
    }

    // Bounce: a slow mochi-squish on impact. Asymmetric curve — quick
    // squish down on the way in, slow ease back out — so it reads like
    // soft rice cake settling rather than a stiff pop.
    if (entry.snap.bounceFrame >= 0 && entry.snap.bounceFrame < BOUNCE_FRAMES) {
      const t = entry.snap.bounceFrame / BOUNCE_FRAMES;
      // Cube-root rise (fast) for t < 0.3, then a long ease-out tail.
      const bend = t < 0.3 ? (t / 0.3) ** 0.5 : 1 - ((t - 0.3) / 0.7) ** 1.4;
      scaleX *= 1 + 0.08 * bend;
      scaleY *= 1 - 0.14 * bend;
    }

    s.scale.set(scaleX, scaleY);
    entry.container.alpha = alpha;

    // Eye overlays. The body is drawn first, then we overlay eyelids
    // when blinking — the body itself never squashes for a blink.
    const blinking = entry.snap.blinkFrames > 0;
    const isWink = blinking && entry.snap.blinkIsWink;
    const winkSide = entry.snap.winkEye;
    entry.leftEyelid.visible = blinking && (!isWink || winkSide === 'L');
    entry.rightEyelid.visible = blinking && (!isWink || winkSide === 'R');

    // Pupil-style look: nudge eyelid sprites (acting as dark dots) in
    // the look direction when no blink is active. This is a subtle
    // hint of the puyo "glancing" somewhere and back.
    if (!blinking && entry.snap.lookFrames > 0) {
      const dx = entry.snap.lookDir * 1.5;
      const dy = entry.snap.lookDirY * 1.5;
      entry.leftEyelid.visible = true;
      entry.rightEyelid.visible = true;
      // For look mode, eyelid graphics are drawn smaller — like a pupil.
      entry.leftEyelid.scale.set(0.45);
      entry.rightEyelid.scale.set(0.45);
      entry.leftEyelid.x = -EYE_OFFSET_X + dx;
      entry.leftEyelid.y = EYE_OFFSET_Y + dy;
      entry.rightEyelid.x = EYE_OFFSET_X + dx;
      entry.rightEyelid.y = EYE_OFFSET_Y + dy;
    } else {
      entry.leftEyelid.scale.set(1);
      entry.rightEyelid.scale.set(1);
      entry.leftEyelid.x = -EYE_OFFSET_X;
      entry.leftEyelid.y = EYE_OFFSET_Y;
      entry.rightEyelid.x = EYE_OFFSET_X;
      entry.rightEyelid.y = EYE_OFFSET_Y;
    }
  }

  /**
   * If the spec looks like a new same-color cell that just appeared
   * lower than a now-gone sprite in the same column, return that
   * source's id so we can hand off its displayed y for the fall.
   *
   * Picks the LOWEST available source above the new cell so that
   * stacked falls preserve the original vertical order — the cell
   * originally on top stays on top, fall distances scale with the
   * pre-gravity gap, and uniform pixel-per-frame speed keeps the
   * stack moving as a single unit.
   */
  private findFallSource(spec: FieldSprite): string | null {
    const m = /^cell:(\d+):(\d+)$/.exec(spec.id);
    if (!m) return null;
    const x = Number(m[1]);
    const y = Number(m[2]);
    let bestSourceId: string | null = null;
    let bestY = Number.POSITIVE_INFINITY;
    for (const [id, entry] of this.boardSprites) {
      if (!id.startsWith(`cell:${x}:`)) continue;
      if (entry.snap.kind !== spec.cellKind) continue;
      const m2 = /^cell:\d+:(\d+)$/.exec(id);
      if (!m2) continue;
      const sourceY = Number(m2[1]);
      if (sourceY <= y) continue;
      if (sourceY < bestY) {
        bestY = sourceY;
        bestSourceId = id;
      }
    }
    return bestSourceId;
  }

  /** RGB tint for particles when a cell of `kind` pops. */
  private getTintForKind(kind: string): number {
    switch (kind) {
      case 'R':
        return 0xff4a6b;
      case 'G':
        return 0x6ce048;
      case 'Y':
        return 0xffd23a;
      case 'B':
        return 0x4a9bff;
      case 'P':
        return 0xc864ff;
      default:
        return 0xffffff;
    }
  }

  // ----------------------------------------------------------------
  // Particles (pop bursts)
  // ----------------------------------------------------------------

  private emitBurst(x: number, y: number, color: number): void {
    const count = 10;
    const life = 30;
    for (let i = 0; i < count; i++) {
      // Particles are drawn at radius 1 and scaled per-frame via the
      // size ramp curve; that way one Graphics buffer suffices.
      const g = new Graphics();
      g.circle(0, 0, 1);
      g.fill({ color, alpha: 1 });
      g.x = x;
      g.y = y;
      this.burstLayer.addChild(g);
      const angle = (i / count) * Math.PI * 2 + Math.random() * 0.4 - 0.2;
      const speed = 4 + Math.random() * 2.5;
      this.particles.push({
        graphic: g,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 2,
        life,
        maxLife: life,
      });
    }
  }

  private tickParticles(): void {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i] as Particle;
      p.graphic.x += p.vx;
      p.graphic.y += p.vy;
      p.vy += 0.18; // gravity drag

      p.life -= 1;
      const t = 1 - p.life / p.maxLife; // 0..1 across the lifetime
      // Size ramp: small → big → small. Bell curve via sin(πt).
      const ramp = Math.sin(t * Math.PI);
      // Peak radius reduced from 12 → 8.4px (70% of the original) and
      // the base shrunk in proportion, per playtest feedback that the
      // burst grains were overpowering the puyo silhouettes.
      const peak = 8.4;
      p.graphic.scale.set(1.4 + peak * ramp);
      p.graphic.alpha = Math.min(1, ramp * 1.4);
      if (p.life <= 0) {
        this.burstLayer.removeChild(p.graphic);
        p.graphic.destroy();
        this.particles.splice(i, 1);
      }
    }
  }

  // ----------------------------------------------------------------
  // Active piece
  // ----------------------------------------------------------------

  private updatePieceSprites(specs: FieldSprite[], player: PlayerState): void {
    const axisSpec = specs.find((s) => s.kind === 'axis') ?? null;
    const childSpec = specs.find((s) => s.kind === 'child') ?? null;
    const piece = player.current;

    if (!piece || !axisSpec || !childSpec) {
      for (const sprite of this.pieceSprites.values()) {
        this.spriteLayer.removeChild(sprite);
        sprite.destroy();
      }
      this.pieceSprites.clear();
      this.pieceAnim = null;
      return;
    }

    let axisSprite = this.pieceSprites.get('axis');
    let childSprite = this.pieceSprites.get('child');
    if (!axisSprite) {
      axisSprite = makeSprite(this.sheet.get(axisSpec.cellKind));
      this.pieceSprites.set('axis', axisSprite);
      this.spriteLayer.addChild(axisSprite);
    } else {
      axisSprite.texture = this.sheet.get(axisSpec.cellKind);
    }
    if (!childSprite) {
      childSprite = makeSprite(this.sheet.get(childSpec.cellKind));
      this.pieceSprites.set('child', childSprite);
      this.spriteLayer.addChild(childSprite);
    } else {
      childSprite.texture = this.sheet.get(childSpec.cellKind);
    }

    const targetAngle = ANGLE_BY_ROTATION[piece.rotation] as number;
    const targetAxisX = axisSpec.x;
    const targetAxisY = axisSpec.y;

    if (!this.pieceAnim) {
      this.pieceAnim = {
        currentAngle: targetAngle,
        displayAxisX: targetAxisX,
        displayAxisY: targetAxisY,
        targetAngle,
        targetAxisX,
        targetAxisY,
        rotProgress: 1,
        lastRotation: piece.rotation,
      };
    } else if (piece.rotation !== this.pieceAnim.lastRotation) {
      // Rotation change → start a fresh arc animation.
      const fromAngle = this.pieceAnim.currentAngle;
      const toAngle = pickShortTarget(fromAngle, targetAngle);
      this.pieceAnim.targetAngle = toAngle;
      this.pieceAnim.targetAxisX = targetAxisX;
      this.pieceAnim.targetAxisY = targetAxisY;
      this.pieceAnim.rotProgress = 0;
      this.pieceAnim.lastRotation = piece.rotation;
    } else {
      // No rotation change. Horizontal move → SNAP. Soft drop
      // descent → SMOOTH. Natural fall → SNAP.
      this.pieceAnim.currentAngle = targetAngle;
      this.pieceAnim.targetAngle = targetAngle;
      this.pieceAnim.targetAxisX = targetAxisX;
      this.pieceAnim.targetAxisY = targetAxisY;
      this.pieceAnim.rotProgress = 1;

      // Horizontal always snaps.
      this.pieceAnim.displayAxisX = targetAxisX;

      // Vertical: smooth while soft-dropping, snap otherwise. Smoothing
      // is a CONSTANT pixel step per frame (matching the simulator's
      // soft-drop pace) so the descent reads as steady-velocity instead
      // of the exponential ease-in the old lerp produced.
      if (player.softDrop && targetAxisY !== this.pieceAnim.displayAxisY) {
        const dy = targetAxisY - this.pieceAnim.displayAxisY;
        const step = Math.sign(dy) * Math.min(Math.abs(dy), SOFT_DROP_STEP);
        this.pieceAnim.displayAxisY += step;
        if (Math.abs(targetAxisY - this.pieceAnim.displayAxisY) < 0.5) {
          this.pieceAnim.displayAxisY = targetAxisY;
        }
      } else {
        this.pieceAnim.displayAxisY = targetAxisY;
      }
    }

    // Rotation animation progress.
    if (this.pieceAnim.rotProgress < 1) {
      const prev = this.pieceAnim.rotProgress;
      const next = Math.min(1, prev + 1 / ROTATION_FRAMES);
      this.pieceAnim.rotProgress = next;
      const stepT =
        (easeOutCubic(next) - easeOutCubic(prev)) / Math.max(1e-6, 1 - easeOutCubic(prev));
      this.pieceAnim.currentAngle +=
        (this.pieceAnim.targetAngle - this.pieceAnim.currentAngle) * stepT;
      this.pieceAnim.displayAxisX +=
        (this.pieceAnim.targetAxisX - this.pieceAnim.displayAxisX) * stepT;
      this.pieceAnim.displayAxisY +=
        (this.pieceAnim.targetAxisY - this.pieceAnim.displayAxisY) * stepT;
      if (next === 1) {
        this.pieceAnim.currentAngle = this.pieceAnim.targetAngle;
        this.pieceAnim.displayAxisX = this.pieceAnim.targetAxisX;
        this.pieceAnim.displayAxisY = this.pieceAnim.targetAxisY;
      }
    }

    axisSprite.x = this.pieceAnim.displayAxisX;
    axisSprite.y = this.pieceAnim.displayAxisY;
    axisSprite.scale.set(BASE_SCALE);
    axisSprite.alpha = 1;
    const angle = this.pieceAnim.currentAngle;
    childSprite.x = this.pieceAnim.displayAxisX + Math.cos(angle) * CELL_SIZE;
    childSprite.y = this.pieceAnim.displayAxisY + Math.sin(angle) * CELL_SIZE;
    childSprite.scale.set(BASE_SCALE);
    childSprite.alpha = 1;
  }

  // ----------------------------------------------------------------
  // Field frame
  // ----------------------------------------------------------------

  private drawFrame(): void {
    const g = this.frameLayer;
    g.clear();

    g.rect(FIELD_ORIGIN_X, FIELD_ORIGIN_Y, FIELD_PIXEL_WIDTH, FIELD_PIXEL_HEIGHT);
    g.fill(0x0c0c1f);

    for (let i = 1; i < FIELD_COLS; i++) {
      const x = FIELD_ORIGIN_X + i * CELL_SIZE;
      g.moveTo(x, FIELD_ORIGIN_Y);
      g.lineTo(x, FIELD_ORIGIN_Y + FIELD_PIXEL_HEIGHT);
    }
    for (let j = 1; j < VISIBLE_ROWS; j++) {
      const y = FIELD_ORIGIN_Y + j * CELL_SIZE;
      g.moveTo(FIELD_ORIGIN_X, y);
      g.lineTo(FIELD_ORIGIN_X + FIELD_PIXEL_WIDTH, y);
    }
    g.stroke({ width: 1, color: GRID_LINE_COLOR, alpha: 0.6 });

    g.rect(FIELD_ORIGIN_X, FIELD_ORIGIN_Y, FIELD_PIXEL_WIDTH, FIELD_PIXEL_HEIGHT);
    g.stroke({ width: 3, color: FRAME_LINE_COLOR });
  }
}

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

function makeSprite(texture: Texture): Sprite {
  const s = new Sprite(texture);
  s.anchor.set(0.5);
  s.scale.set(BASE_SCALE);
  return s;
}

/** Two-pixel-tall dark eyelid graphic, drawn centered. */
function makeEyelid(): Graphics {
  const g = new Graphics();
  g.rect(-EYE_W / 2, -EYE_H / 2, EYE_W, EYE_H);
  g.fill(EYELID_COLOR);
  return g;
}

function easeOutCubic(t: number): number {
  const inv = 1 - t;
  return 1 - inv * inv * inv;
}

function pickShortTarget(from: number, naiveTarget: number): number {
  let delta = naiveTarget - from;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  return from + delta;
}

/**
 * Pseudo-Poisson per-puyo offset (uniform 0.5x..1.5x of the mean) so
 * adjacent puyos don't blink/look in lockstep.
 */
function randomDelay(meanFrames: number): number {
  const jitter = 0.5 + Math.random();
  return Math.floor(meanFrames * jitter);
}
