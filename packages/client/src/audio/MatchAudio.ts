/**
 * MatchAudio — shared SE driver for solo + networked matches.
 *
 * Both match scenes have the same audio needs: a chain-pop when the
 * local player's chain count ticks up, piece-land / piece-spawn on
 * phase transitions, ojama-drop on incoming garbage, plus match-start
 * and match-end stingers. Each scene used to wire this inline, with
 * NetworkedMatchScene quietly omitting it entirely and leaving online
 * play silent. Factoring it out keeps both call sites identical.
 */

import type { MatchState, PlayerId } from '@chaindrop/shared';
import { audioBus } from './AudioBus';

export interface MatchAudio {
  /**
   * Call once per `onFrameAdvanced` tick so the helper can diff
   * against the prior frame and fire SE on transitions.
   */
  onFrameAdvanced(match: MatchState): void;
  /** Match-start stinger + BGM ramp-up. Idempotent. */
  start(): Promise<void>;
  /** Match-end stinger + BGM stop. Idempotent. */
  end(): void;
  /** Stop BGM without playing the end stinger (e.g. exit-to-title). */
  stop(): void;
}

interface Options {
  /**
   * Which player is "local" for audio purposes. Their phase changes
   * and chain-pops drive the SE; opponent events are ignored to keep
   * the soundscape coherent.
   */
  localPlayerId: PlayerId;
}

export function createMatchAudio({ localPlayerId }: Options): MatchAudio {
  let prevChain = 0;
  let prevPhase = '';
  let started = false;
  let ended = false;

  return {
    onFrameAdvanced(match: MatchState): void {
      const p = match.players.find((pl) => pl.id === localPlayerId);
      if (!p) return;

      // Chain pop fires each tick the chainCount goes up — every
      // chain link gets its own poke.
      if (p.chainCount > prevChain) audioBus.playSe('chain-pop');
      prevChain = p.chainCount;

      // Lock SE: falling → resolving/chigiri.
      if (prevPhase === 'falling' && (p.phase === 'resolving' || p.phase === 'chigiri')) {
        audioBus.playSe('piece-land');
      }
      // Spawn SE: !falling → falling. Skips the first frame when
      // prevPhase is the empty-string initial value.
      if (prevPhase && prevPhase !== 'falling' && p.phase === 'falling') {
        audioBus.playSe('piece-spawn');
      }
      prevPhase = p.phase;

      // Ojama drop SE — one per drop event addressed to the local
      // player. We read from match.events which is repopulated each
      // frame by advanceFrame.
      for (const ev of match.events) {
        if (ev.type === 'ojama_drop' && ev.playerId === localPlayerId && ev.dropped > 0) {
          audioBus.playSe('ojama-drop');
        }
      }
    },

    async start(): Promise<void> {
      if (started) return;
      started = true;
      await audioBus.ensureUnlocked();
      audioBus.playSe('match-start');
      audioBus.startBgm();
    },

    end(): void {
      if (ended) return;
      ended = true;
      audioBus.playSe('match-end');
      audioBus.stopBgm();
    },

    stop(): void {
      audioBus.stopBgm();
    },
  };
}
