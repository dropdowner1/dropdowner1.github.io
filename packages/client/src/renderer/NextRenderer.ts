/**
 * NEXT preview — shows the next two upcoming pieces in a compact panel
 * to the right of the main field.
 *
 * Slot 0 (top, larger): the piece that will spawn next.
 * Slot 1 (bottom, smaller): the one after.
 *
 * When `dropQueueIndex` advances (the active piece locks), the panel
 * shifts everything up by one slot over `SLIDE_FRAMES`:
 *   - The previous slot-0 puyo slides up and fades out off the top.
 *   - The previous slot-1 puyo slides up into slot 0.
 *   - A brand-new puyo slides in from below into slot 1.
 *
 * To keep that three-piece transition possible inside a panel that only
 * shows two at rest, the renderer maintains three sprite "tracks" and
 * picks which queue index each track points at depending on whether a
 * slide is in flight.
 */

import type { MatchState } from '@chaindrop/shared';
import { Container, Graphics, Sprite } from 'pixi.js';
import type { PuyoSheet } from './PuyoTexture';
import { SHEET_CELL } from './PuyoTexture';
import { FIELD_ORIGIN_X, FIELD_PIXEL_WIDTH } from './layout';

/**
 * Horizontal gap between the field and the NEXT panel. Same on both
 * sides so a mirrored panel looks symmetric.
 */
const PANEL_GAP = 32;
const PANEL_Y = 80;
const PANEL_WIDTH = 130;
/** Default (right-side) panel anchor — to the right of the field. */
const PANEL_X_RIGHT = FIELD_ORIGIN_X + FIELD_PIXEL_WIDTH + PANEL_GAP;
/** Mirrored anchor — to the left of the field. */
const PANEL_X_LEFT = FIELD_ORIGIN_X - PANEL_GAP - PANEL_WIDTH;

/** Cell size in slot 0 (top, full) and slot 1 (bottom, secondary). */
const SLOT0_CELL = 44;
const SLOT1_CELL = 32;
const VERTICAL_GAP = 18;
const PANEL_TOP_PAD = 28;
const PANEL_BOTTOM_PAD = 20;

/** Frames over which one slot-shift animates after a piece is consumed. */
const SLIDE_FRAMES = 10;

const FRAME_COLOR = 0xffd60a;
const PANEL_BG = 0x0c0c1f;

interface Track {
  container: Container;
  axis: Sprite;
  child: Sprite;
  cell: number;
}

export interface NextRendererOptions {
  /**
   * Where the panel sits relative to the field. Default is `right`
   * (next to the field's right edge), used in solo and by the left
   * player in 1v1. The right player in 1v1 uses `left` so its panel
   * doesn't run off the edge of the 1280-wide internal stage.
   */
  side?: 'left' | 'right';
}

export class NextRenderer {
  readonly container: Container;
  private frame: Graphics;
  private tracks: Track[] = []; // length 3: out / mid / in
  private slot0RestY = 0;
  private slot1RestY = 0;
  private offTopY = 0;
  private offBottomY = 0;
  /** dropQueueIndex value observed on the last update; drives the slide. */
  private lastDropQueueIndex = -1;
  /** 0..SLIDE_FRAMES while slots are mid-shift; -1 when at rest. */
  private slideFrame = -1;
  private readonly panelHeight: number;
  private readonly panelX: number;

  constructor(
    private sheet: PuyoSheet,
    options: NextRendererOptions = {},
  ) {
    this.container = new Container();
    this.frame = new Graphics();
    this.container.addChild(this.frame);
    this.panelX = options.side === 'left' ? PANEL_X_LEFT : PANEL_X_RIGHT;

    // Panel geometry.
    const total = SLOT0_CELL * 2 + VERTICAL_GAP + SLOT1_CELL * 2 + PANEL_TOP_PAD + PANEL_BOTTOM_PAD;
    this.panelHeight = total;
    this.slot0RestY = PANEL_Y + PANEL_TOP_PAD + SLOT0_CELL / 2;
    this.slot1RestY = this.slot0RestY + SLOT0_CELL + VERTICAL_GAP + SLOT1_CELL / 2;
    this.offTopY = PANEL_Y - SLOT0_CELL;
    this.offBottomY = PANEL_Y + this.panelHeight + SLOT1_CELL;

    // Clip everything outside the frame so sliding sprites don't bleed
    // into the HUD.
    const mask = new Graphics();
    mask.rect(this.panelX, PANEL_Y, PANEL_WIDTH, this.panelHeight);
    mask.fill(0xffffff);
    this.container.addChild(mask);
    this.container.mask = mask;

    this.drawFrame();
    this.buildTracks();
  }

  update(match: MatchState, playerIndex = 0): void {
    const player = match.players[playerIndex];
    if (!player) return;
    const baseIndex = player.dropQueueIndex;

    // Kick off a slide animation when the queue index advances by one
    // (the player just consumed a piece). Multi-step jumps shouldn't
    // animate — those happen on reset/spawn and benefit from snapping.
    if (this.lastDropQueueIndex >= 0 && baseIndex === this.lastDropQueueIndex + 1) {
      this.slideFrame = 0;
    } else if (this.lastDropQueueIndex !== baseIndex) {
      this.slideFrame = -1;
    }
    this.lastDropQueueIndex = baseIndex;

    const sliding = this.slideFrame >= 0 && this.slideFrame < SLIDE_FRAMES;

    if (sliding) {
      // Outgoing piece (was in slot 0, now sliding off the top).
      this.paintTrack(0, match.dropQueue[baseIndex - 1]);
      // Moving-up piece (was in slot 1, now sliding into slot 0).
      this.paintTrack(1, match.dropQueue[baseIndex]);
      // Incoming piece (sliding in from below into slot 1).
      this.paintTrack(2, match.dropQueue[baseIndex + 1]);
    } else {
      // At rest: track 0 holds the current next at slot 0, track 1 holds
      // the next-next at slot 1, track 2 is parked off-bottom invisible.
      this.paintTrack(0, match.dropQueue[baseIndex]);
      this.paintTrack(1, match.dropQueue[baseIndex + 1]);
      const t2 = this.tracks[2];
      if (t2) t2.container.visible = false;
    }

    // Apply positions for this frame (t=0 means at rest).
    const t = sliding ? easeInOutQuad((this.slideFrame + 1) / SLIDE_FRAMES) : 0;
    this.layoutTracks(t);

    if (sliding) {
      this.slideFrame += 1;
      if (this.slideFrame >= SLIDE_FRAMES) this.slideFrame = -1;
    }
  }

  destroy(): void {
    for (const t of this.tracks) t.container.destroy({ children: true });
    this.tracks = [];
    this.frame.destroy();
    this.container.destroy({ children: true });
  }

  // ----------------------------------------------------------------

  private drawFrame(): void {
    const g = this.frame;
    g.clear();
    g.rect(this.panelX, PANEL_Y, PANEL_WIDTH, this.panelHeight);
    g.fill(PANEL_BG);
    g.rect(this.panelX, PANEL_Y, PANEL_WIDTH, this.panelHeight);
    g.stroke({ width: 2, color: FRAME_COLOR });
  }

  private buildTracks(): void {
    // 3 tracks share the same "slot 0" rendering size — the panel is
    // narrow enough that scaling each one independently is overkill, and
    // the visual hierarchy (top piece bigger) is preserved by which
    // y-coordinate each track ends at, not by its cell size. Slot 1
    // shrinks to SLOT1_CELL at rest via `layoutTracks`.
    for (let i = 0; i < 3; i++) {
      const slot = new Container();
      slot.x = this.panelX + PANEL_WIDTH / 2;
      slot.y = this.slot0RestY;
      const axis = new Sprite();
      axis.anchor.set(0.5);
      axis.x = 0;
      slot.addChild(axis);
      const child = new Sprite();
      child.anchor.set(0.5);
      child.x = 0;
      slot.addChild(child);
      this.tracks.push({ container: slot, axis, child, cell: SLOT0_CELL });
      this.container.addChild(slot);
    }
  }

  private paintTrack(i: number, pair: readonly [string, string] | undefined): void {
    const track = this.tracks[i];
    if (!track) return;
    if (pair) {
      track.axis.texture = this.sheet.get(pair[0] as 'R');
      track.child.texture = this.sheet.get(pair[1] as 'R');
      track.container.visible = true;
    } else {
      track.container.visible = false;
    }
  }

  /**
   * Position each track for a given slide progress `t` ∈ [0, 1].
   *   t = 0  → at-rest layout (only tracks 1, 2 visible, in slot 0 and
   *           slot 1 respectively).
   *   t = 1  → fully shifted: track 0 off the top (faded), track 1 at
   *           slot 0, track 2 at slot 1.
   * Intermediate values interpolate linearly between those anchors.
   */
  private layoutTracks(t: number): void {
    // Track 0 (outgoing): slot 0 → off-top, fading out.
    const t0 = this.tracks[0];
    if (t0) {
      t0.container.y = this.slot0RestY + (this.offTopY - this.slot0RestY) * t;
      t0.container.alpha = 1 - t;
      this.applyCell(t0, SLOT0_CELL);
    }
    // Track 1 (moving-up): slot 1 → slot 0. Cell grows from SLOT1 → SLOT0.
    const t1 = this.tracks[1];
    if (t1) {
      t1.container.y = this.slot1RestY + (this.slot0RestY - this.slot1RestY) * t;
      t1.container.alpha = 1;
      const cell = SLOT1_CELL + (SLOT0_CELL - SLOT1_CELL) * t;
      this.applyCell(t1, cell);
    }
    // Track 2 (incoming): off-bottom → slot 1. Fades in.
    const t2 = this.tracks[2];
    if (t2) {
      t2.container.y = this.offBottomY + (this.slot1RestY - this.offBottomY) * t;
      t2.container.alpha = t;
      this.applyCell(t2, SLOT1_CELL);
    }
  }

  /** Set sprite scale + relative child offset for the given cell size. */
  private applyCell(track: Track, cell: number): void {
    const scale = cell / SHEET_CELL;
    track.axis.scale.set(scale);
    track.child.scale.set(scale);
    track.child.y = cell;
    track.cell = cell;
  }
}

function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}
