/**
 * BackgroundRenderer — an ambient, seamlessly-looping backdrop for the
 * match scenes so the play area isn't floating on a flat dark void.
 *
 * Purely decorative: soft translucent puyo-coloured bubbles drift
 * upward with a gentle sine sway, wrapping from top back to bottom.
 * Everything is procedural (no video/image assets, nothing to load)
 * and renderer-local — randomness here never touches the deterministic
 * simulator, so lockstep stays byte-identical across clients.
 *
 * Alpha is kept low (≤ ~0.12) so the field and pieces stay perfectly
 * readable on top.
 */

import { Container, Graphics } from 'pixi.js';
import { INTERNAL_HEIGHT, INTERNAL_WIDTH, PUYO_COLORS } from './layout';

interface Bubble {
  g: Graphics;
  baseX: number;
  y: number;
  radius: number;
  /** Upward drift in px/frame. Bigger bubbles rise faster (parallax). */
  speed: number;
  /** Horizontal sway: x = baseX + sin(t * freq + phase) * amp. */
  swayAmp: number;
  swayFreq: number;
  phase: number;
}

const BUBBLE_COUNT = 26;
const BUBBLE_COLORS = [PUYO_COLORS.R, PUYO_COLORS.G, PUYO_COLORS.B, PUYO_COLORS.Y, PUYO_COLORS.P];

export class BackgroundRenderer {
  readonly container: Container;
  private bubbles: Bubble[] = [];
  private t = 0;

  constructor() {
    this.container = new Container();

    for (let i = 0; i < BUBBLE_COUNT; i++) {
      const radius = 14 + Math.random() * 52;
      const color = BUBBLE_COLORS[i % BUBBLE_COLORS.length] as number;
      const g = new Graphics();
      // Soft two-tone blob: dim body + slightly brighter core so the
      // bubble reads as round rather than a flat disc.
      g.circle(0, 0, radius);
      g.fill({ color, alpha: 0.05 + (radius / 66) * 0.05 });
      g.circle(-radius * 0.25, -radius * 0.25, radius * 0.45);
      g.fill({ color: 0xffffff, alpha: 0.03 });

      const bubble: Bubble = {
        g,
        baseX: Math.random() * INTERNAL_WIDTH,
        y: Math.random() * INTERNAL_HEIGHT,
        radius,
        speed: 0.12 + (radius / 66) * 0.5,
        swayAmp: 8 + Math.random() * 22,
        swayFreq: 0.004 + Math.random() * 0.006,
        phase: Math.random() * Math.PI * 2,
      };
      g.x = bubble.baseX;
      g.y = bubble.y;
      this.bubbles.push(bubble);
      this.container.addChild(g);
    }
  }

  /** Advance one render frame. Call from the scene's onRender. */
  tick(): void {
    this.t += 1;
    for (const b of this.bubbles) {
      b.y -= b.speed;
      // Wrapped seamlessly: once fully above the top edge, re-enter
      // below the bottom at a fresh horizontal spot.
      if (b.y < -b.radius * 2) {
        b.y = INTERNAL_HEIGHT + b.radius * 2;
        b.baseX = Math.random() * INTERNAL_WIDTH;
      }
      b.g.x = b.baseX + Math.sin(this.t * b.swayFreq + b.phase) * b.swayAmp;
      b.g.y = b.y;
    }
  }

  destroy(): void {
    for (const b of this.bubbles) b.g.destroy();
    this.bubbles = [];
    this.container.destroy({ children: true });
  }
}
