import { beforeEach, describe, expect, it } from 'vitest';
import { validateAccountForm } from './account';
import { EMPTY_RECORDS, appendOnlineHistory, recordSoloRun } from './records';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from './settings';

beforeEach(() => {
  window.localStorage.clear();
});

describe('settings', () => {
  it('returns the defaults when nothing has been persisted', () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('round-trips a saved value', () => {
    saveSettings({ bgmVolume: 3, seVolume: 9, colorMode: 'mono' });
    expect(loadSettings()).toEqual({ bgmVolume: 3, seVolume: 9, colorMode: 'mono' });
  });

  it('clamps volumes that fall outside the 0..10 range', () => {
    window.localStorage.setItem(
      'chaindrop.settings.v1',
      JSON.stringify({ bgmVolume: -5, seVolume: 99, colorMode: 'standard' }),
    );
    const loaded = loadSettings();
    expect(loaded.bgmVolume).toBe(0);
    expect(loaded.seVolume).toBe(10);
  });

  it('falls back to default colorMode on garbage input', () => {
    window.localStorage.setItem(
      'chaindrop.settings.v1',
      JSON.stringify({ bgmVolume: 5, seVolume: 5, colorMode: 'rainbow' }),
    );
    expect(loadSettings().colorMode).toBe('standard');
  });
});

describe('records', () => {
  it('keeps the rolling max of bestScore and bestMaxChain', () => {
    const r1 = recordSoloRun(EMPTY_RECORDS, { score: 1200, maxChain: 4, totalCleared: 20 });
    expect(r1.solo.bestScore).toBe(1200);
    expect(r1.solo.bestMaxChain).toBe(4);
    expect(r1.solo.totalCleared).toBe(20);

    const r2 = recordSoloRun(r1, { score: 800, maxChain: 7, totalCleared: 18 });
    // bestScore stays at 1200; bestMaxChain ratchets to 7;
    // totalCleared accumulates.
    expect(r2.solo.bestScore).toBe(1200);
    expect(r2.solo.bestMaxChain).toBe(7);
    expect(r2.solo.totalCleared).toBe(38);
  });

  it('stamps bestScoreAt only when a run actually beats the previous best', () => {
    const r1 = recordSoloRun(EMPTY_RECORDS, { score: 1200, maxChain: 4, totalCleared: 20 });
    expect(r1.solo.bestScoreAt).toBeTruthy();
    const stamp = r1.solo.bestScoreAt;
    const r2 = recordSoloRun(r1, { score: 800, maxChain: 4, totalCleared: 5 });
    // didn't beat → timestamp unchanged
    expect(r2.solo.bestScoreAt).toBe(stamp);
  });

  it('prepends online history newest-first', () => {
    const r1 = appendOnlineHistory(EMPTY_RECORDS, {
      at: '2026-05-01T00:00:00.000Z',
      opponentNickname: 'A',
      outcome: 'win',
      selfScore: 1000,
    });
    const r2 = appendOnlineHistory(r1, {
      at: '2026-05-02T00:00:00.000Z',
      opponentNickname: 'B',
      outcome: 'loss',
      selfScore: 500,
    });
    expect(r2.online[0]?.opponentNickname).toBe('B');
    expect(r2.online[1]?.opponentNickname).toBe('A');
  });
});

describe('validateAccountForm', () => {
  const good = {
    playerName: 'ぷよ太郎',
    userId: 'puyo_001',
    password: 'p4ssw0rd!',
  };

  it('accepts a well-formed input', () => {
    expect(validateAccountForm(good)).toEqual({});
  });

  it('rejects an empty player name', () => {
    expect(validateAccountForm({ ...good, playerName: '' }).playerName).toBeDefined();
  });

  it('rejects a userId with non-alnum characters', () => {
    expect(validateAccountForm({ ...good, userId: 'puyo 001' }).userId).toBeDefined();
    expect(validateAccountForm({ ...good, userId: 'ぷよ' }).userId).toBeDefined();
  });

  it('rejects passwords shorter than 8 characters', () => {
    expect(validateAccountForm({ ...good, password: 'p4ssw0r' }).password).toBeDefined();
  });
});
