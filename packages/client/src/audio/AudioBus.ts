/**
 * AudioBus — a thin Web Audio API wrapper that lets the whole app
 * trigger SE one-shots and switch a BGM loop on/off from anywhere
 * without each scene having to keep its own AudioContext.
 *
 * Phase A keeps everything synthesised at runtime so we don't need to
 * vendor any audio files. SE are short oscillator + envelope blips;
 * BGM is a looping 8-bar square-wave melody. The whole engine sits
 * behind an `ensureUnlocked()` gate because browsers won't let an
 * AudioContext resume without a user gesture.
 *
 * Volumes are 0..10 (matching the settings slider) and mapped to a
 * 0..1 GainNode value through a quadratic curve so quiet steps feel
 * meaningful.
 */

export type SeName =
  | 'ui-click'
  | 'piece-rotate'
  | 'piece-move'
  | 'piece-land'
  | 'piece-spawn'
  | 'chain-pop'
  | 'match-start'
  | 'match-end'
  | 'ojama-drop';

const SE_DEFS: Record<SeName, { freq: number; durMs: number; type?: OscillatorType }> = {
  'ui-click': { freq: 880, durMs: 60, type: 'square' },
  'piece-rotate': { freq: 720, durMs: 60, type: 'square' },
  'piece-move': { freq: 440, durMs: 35, type: 'square' },
  'piece-land': { freq: 220, durMs: 110, type: 'triangle' },
  'piece-spawn': { freq: 520, durMs: 70, type: 'sine' },
  'chain-pop': { freq: 1320, durMs: 180, type: 'square' },
  'match-start': { freq: 660, durMs: 220, type: 'square' },
  'match-end': { freq: 220, durMs: 320, type: 'triangle' },
  // Heavy thud for incoming ojama — low + long so a wave of garbage
  // reads viscerally.
  'ojama-drop': { freq: 110, durMs: 260, type: 'triangle' },
};

/**
 * 16-step BGM motif in semitone offsets from A3. Plays as a square
 * wave at one note per 200ms (~120 BPM eighth-notes), wraps round
 * forever. The arpeggio shape is deliberately neutral SFC-puzzle
 * adjacent without being a direct quote of any commercial track.
 */
const BGM_NOTES: readonly number[] = [0, 4, 7, 12, 7, 4, 0, 4, -2, 2, 5, 10, 5, 2, -2, 2];
const BGM_NOTE_MS = 200;
const A3_FREQ = 220;

export class AudioBus {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private bgmGain: GainNode | null = null;
  private seGain: GainNode | null = null;

  private bgmRunning = false;
  private bgmTimer: ReturnType<typeof setTimeout> | null = null;
  private bgmStep = 0;

  /** 0..10. Stored even before the ctx exists so we can apply on unlock. */
  private bgmVolume = 5;
  private seVolume = 7;

  setBgmVolume(v: number): void {
    this.bgmVolume = clamp10(v);
    if (this.bgmGain && this.ctx) this.bgmGain.gain.value = curve(this.bgmVolume) * 0.18;
  }

  setSeVolume(v: number): void {
    this.seVolume = clamp10(v);
    if (this.seGain && this.ctx) this.seGain.gain.value = curve(this.seVolume) * 0.6;
  }

  /**
   * Resume the underlying AudioContext on a user gesture. The browser
   * refuses to start one without one, so every interactive scene
   * should call this in their click handlers. Safe to call repeatedly.
   */
  async ensureUnlocked(): Promise<void> {
    if (!this.ctx) {
      const Ctor =
        typeof window === 'undefined'
          ? null
          : (window.AudioContext ??
            (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 1;
      this.masterGain.connect(this.ctx.destination);

      this.bgmGain = this.ctx.createGain();
      this.bgmGain.gain.value = curve(this.bgmVolume) * 0.18;
      this.bgmGain.connect(this.masterGain);

      this.seGain = this.ctx.createGain();
      this.seGain.gain.value = curve(this.seVolume) * 0.6;
      this.seGain.connect(this.masterGain);
    }
    if (this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch {
        /* ignore — autoplay policy denied */
      }
    }
  }

  playSe(name: SeName): void {
    const ctx = this.ctx;
    if (!ctx || !this.seGain) return;
    if (this.seVolume === 0) return;
    const def = SE_DEFS[name];
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = def.type ?? 'square';
    osc.frequency.value = def.freq;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(1, t + 0.003);
    env.gain.exponentialRampToValueAtTime(0.001, t + def.durMs / 1000);
    osc.connect(env);
    env.connect(this.seGain);
    osc.start(t);
    osc.stop(t + def.durMs / 1000 + 0.02);
  }

  startBgm(): void {
    if (this.bgmRunning) return;
    if (!this.ctx || !this.bgmGain) return;
    this.bgmRunning = true;
    this.bgmStep = 0;
    this.tickBgm();
  }

  stopBgm(): void {
    this.bgmRunning = false;
    if (this.bgmTimer) {
      clearTimeout(this.bgmTimer);
      this.bgmTimer = null;
    }
  }

  // ----------------------------------------------------------------

  private tickBgm(): void {
    if (!this.bgmRunning || !this.ctx || !this.bgmGain) return;
    const semitone = BGM_NOTES[this.bgmStep % BGM_NOTES.length] as number;
    const freq = A3_FREQ * 2 ** (semitone / 12);
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = freq;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(1, t + 0.01);
    env.gain.setValueAtTime(1, t + (BGM_NOTE_MS - 30) / 1000);
    env.gain.exponentialRampToValueAtTime(0.001, t + BGM_NOTE_MS / 1000);
    osc.connect(env);
    env.connect(this.bgmGain);
    osc.start(t);
    osc.stop(t + (BGM_NOTE_MS + 20) / 1000);

    this.bgmStep++;
    this.bgmTimer = setTimeout(() => this.tickBgm(), BGM_NOTE_MS);
  }
}

function clamp10(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(10, Math.round(v)));
}

/**
 * Quadratic taper — gives the bottom slider steps audible spacing,
 * which a linear 0..1 map does not. Step 0 still hard-mutes.
 */
function curve(v: number): number {
  if (v <= 0) return 0;
  return (v / 10) * (v / 10);
}

/** Module-level singleton — every scene grabs the same instance. */
export const audioBus = new AudioBus();
