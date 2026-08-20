/**
 * Merge / normalize tests for the cloud save.
 *
 * These are the two places where a bug loses a player's data rather
 * than just failing loudly, so they get direct coverage: a merge that
 * drops a device's games, or a normalize that turns a malformed field
 * into `undefined` and poisons the local store.
 */

import { describe, expect, it } from 'vitest';
import {
  CLOUD_SAVE_VERSION,
  type CloudSavePayload,
  mergePayloads,
  normalizePayload,
} from './cloudSave';
import type { OnlineHistoryEntry } from './records';

function payload(over: Partial<CloudSavePayload> = {}): CloudSavePayload {
  return {
    v: CLOUD_SAVE_VERSION,
    settings: { bgmVolume: 5, seVolume: 7, colorMode: 'standard' },
    difficulty: 'futsuu',
    records: {
      solo: { bestScore: 0, bestMaxChain: 0, totalCleared: 0, bestScoreAt: null },
      online: [],
    },
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function match(at: string, score: number): OnlineHistoryEntry {
  return { at, opponentNickname: 'あいて', outcome: 'win', selfScore: score };
}

describe('mergePayloads', () => {
  it('keeps the higher best score and its timestamp together', () => {
    const local = payload({
      records: {
        solo: {
          bestScore: 100,
          bestMaxChain: 3,
          totalCleared: 40,
          bestScoreAt: '2026-01-02T00:00:00.000Z',
        },
        online: [],
      },
    });
    const remote = payload({
      records: {
        solo: {
          bestScore: 900,
          bestMaxChain: 2,
          totalCleared: 10,
          bestScoreAt: '2026-01-03T00:00:00.000Z',
        },
        online: [],
      },
    });

    const merged = mergePayloads(local, remote);
    expect(merged.records.solo.bestScore).toBe(900);
    // bestScoreAt must follow the winning score, not the newer payload.
    expect(merged.records.solo.bestScoreAt).toBe('2026-01-03T00:00:00.000Z');
    // Each field takes its own max — the chain record survives even
    // though the other side won on score.
    expect(merged.records.solo.bestMaxChain).toBe(3);
    expect(merged.records.solo.totalCleared).toBe(40);
  });

  it('unions online history and drops exact duplicates', () => {
    const shared = match('2026-01-02T00:00:00.000Z', 500);
    const local = payload({
      records: {
        solo: { bestScore: 0, bestMaxChain: 0, totalCleared: 0, bestScoreAt: null },
        online: [match('2026-01-04T00:00:00.000Z', 700), shared],
      },
    });
    const remote = payload({
      records: {
        solo: { bestScore: 0, bestMaxChain: 0, totalCleared: 0, bestScoreAt: null },
        online: [match('2026-01-03T00:00:00.000Z', 600), shared],
      },
    });

    const merged = mergePayloads(local, remote);
    expect(merged.records.online).toHaveLength(3);
    // Newest first.
    expect(merged.records.online.map((e) => e.selfScore)).toEqual([700, 600, 500]);
  });

  it('lets the more recently written side win the scalar preferences', () => {
    const older = payload({
      settings: { bgmVolume: 1, seVolume: 1, colorMode: 'mono' },
      difficulty: 'gekikan',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const newer = payload({
      settings: { bgmVolume: 9, seVolume: 9, colorMode: 'high-contrast' },
      difficulty: 'gekikara',
      updatedAt: '2026-02-01T00:00:00.000Z',
    });

    expect(mergePayloads(older, newer).difficulty).toBe('gekikara');
    expect(mergePayloads(older, newer).settings.colorMode).toBe('high-contrast');
    // Symmetric: whichever argument is newer wins, not whichever is first.
    expect(mergePayloads(newer, older).difficulty).toBe('gekikara');
  });
});

describe('normalizePayload', () => {
  it('rejects non-objects', () => {
    expect(normalizePayload(null)).toBeNull();
    expect(normalizePayload('nope')).toBeNull();
    expect(normalizePayload(42)).toBeNull();
  });

  it('substitutes defaults for missing or malformed fields', () => {
    const out = normalizePayload({ settings: { bgmVolume: 'loud' }, difficulty: 'ultra' });
    expect(out).not.toBeNull();
    expect(out?.settings.bgmVolume).toBe(5);
    expect(out?.difficulty).toBe('futsuu');
    expect(out?.records.online).toEqual([]);
  });

  it('drops history entries that do not have the right shape', () => {
    const out = normalizePayload({
      records: {
        online: [
          match('2026-01-01T00:00:00.000Z', 10),
          { at: 5, opponentNickname: 'x', outcome: 'win', selfScore: 1 },
          { at: '2026-01-01T00:00:00.000Z', outcome: 'exploded', selfScore: 1 },
        ],
      },
    });
    expect(out?.records.online).toHaveLength(1);
    expect(out?.records.online[0]?.selfScore).toBe(10);
  });

  it('round-trips a payload it produced itself', () => {
    const original = payload({
      settings: { bgmVolume: 3, seVolume: 8, colorMode: 'mono' },
      difficulty: 'karakuchi',
      records: {
        solo: {
          bestScore: 1234,
          bestMaxChain: 7,
          totalCleared: 88,
          bestScoreAt: '2026-01-05T00:00:00.000Z',
        },
        online: [match('2026-01-05T00:00:00.000Z', 1234)],
      },
    });
    expect(normalizePayload(original)).toEqual(original);
  });
});
