/**
 * Cloud save — mirrors the browser-local player state into the
 * Techmana account so it follows the player to another device.
 *
 * What lives here is exactly the state that has nowhere else to go:
 * settings, the chosen solo difficulty, and the local records mirror.
 * Online match results already go to ChainDrop's own DB via
 * `api/records`, so they are not the concern of this module.
 *
 * Conflict handling is merge-then-retry rather than last-writer-wins.
 * Two devices playing offline both accumulate real results, and
 * throwing one side away because it synced second would lose games the
 * player actually played. Bests take the max, history is unioned.
 */

import { CloudConflictError, fetchCloudSave, pushCloudSave } from '../api/sync';
import {
  DEFAULT_DIFFICULTY,
  DIFFICULTY_DEFS,
  type DifficultyLevel,
  loadDifficulty,
  saveDifficulty,
} from './difficulty';
import { onLocalStateChanged } from './persistBus';
import {
  EMPTY_RECORDS,
  HISTORY_LIMIT,
  type OnlineHistoryEntry,
  type Records,
  loadRecords,
  saveRecords,
} from './records';
import { DEFAULT_SETTINGS, type Settings, loadSettings, saveSettings } from './settings';

export const CLOUD_SAVE_VERSION = 1;

export interface CloudSavePayload {
  v: number;
  settings: Settings;
  difficulty: DifficultyLevel;
  records: Records;
  /** ISO timestamp; breaks ties for the fields that can't be merged. */
  updatedAt: string;
}

/** Tracks the sequence number of the last save we know about. */
const SEQ_KEY = 'chaindrop.cloudseq.v1';
/** Coalesce bursts of writes (volume slider drags, etc.). */
const PUSH_DEBOUNCE_MS = 3_000;

export type SyncOutcome = 'synced' | 'not-linked' | 'failed';

/* ------------------------------ snapshot ------------------------------ */

export function snapshotLocal(): CloudSavePayload {
  return {
    v: CLOUD_SAVE_VERSION,
    settings: loadSettings(),
    difficulty: loadDifficulty(),
    records: loadRecords(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Write a payload into localStorage. Does not touch the network.
 *
 * The `save*` helpers announce themselves on the persist bus, and this
 * function is the one caller whose writes must NOT be echoed back to
 * the cloud — otherwise applying what we just downloaded would queue a
 * push of it, forever. Suppress for the duration.
 */
export function applyPayload(p: CloudSavePayload): void {
  suppressed = true;
  try {
    saveSettings(p.settings);
    saveDifficulty(p.difficulty);
    saveRecords(p.records);
  } finally {
    suppressed = false;
  }
}

/* ------------------------------- merge -------------------------------- */

export function mergePayloads(local: CloudSavePayload, remote: CloudSavePayload): CloudSavePayload {
  // Scalar preferences can't be merged meaningfully — the most recent
  // edit is the player's actual intent.
  const localWins = Date.parse(local.updatedAt) >= Date.parse(remote.updatedAt);
  return {
    v: CLOUD_SAVE_VERSION,
    settings: localWins ? local.settings : remote.settings,
    difficulty: localWins ? local.difficulty : remote.difficulty,
    records: mergeRecords(local.records, remote.records),
    updatedAt: new Date().toISOString(),
  };
}

function mergeRecords(a: Records, b: Records): Records {
  const seen = new Set<string>();
  const online: OnlineHistoryEntry[] = [];
  for (const e of [...a.online, ...b.online]) {
    const key = `${e.at}|${e.opponentNickname}|${e.outcome}|${e.selfScore}`;
    if (seen.has(key)) continue;
    seen.add(key);
    online.push(e);
  }
  online.sort((x, y) => Date.parse(y.at) - Date.parse(x.at));

  // `totalCleared` is cumulative, so a naive sum would double-count
  // everything the two devices already agreed on. Max is the honest
  // floor: never smaller than what either side has actually seen.
  return {
    solo: {
      bestScore: Math.max(a.solo.bestScore, b.solo.bestScore),
      bestMaxChain: Math.max(a.solo.bestMaxChain, b.solo.bestMaxChain),
      totalCleared: Math.max(a.solo.totalCleared, b.solo.totalCleared),
      bestScoreAt: a.solo.bestScore >= b.solo.bestScore ? a.solo.bestScoreAt : b.solo.bestScoreAt,
    },
    online: online.slice(0, HISTORY_LIMIT),
  };
}

/* ------------------------------ normalize ----------------------------- */

/**
 * Coerce whatever came back from the network into a payload we can
 * use. Anything unrecognised falls back to the default rather than
 * propagating `undefined` into the game state.
 */
export function normalizePayload(raw: unknown): CloudSavePayload | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const d = raw as Record<string, unknown>;
  const settings = (d.settings ?? {}) as Partial<Settings>;
  const records = (d.records ?? {}) as Partial<Records>;
  const solo = (records.solo ?? {}) as Partial<Records['solo']>;
  const difficulty = DIFFICULTY_DEFS.some((x) => x.id === d.difficulty)
    ? (d.difficulty as DifficultyLevel)
    : DEFAULT_DIFFICULTY;

  return {
    v: typeof d.v === 'number' ? d.v : CLOUD_SAVE_VERSION,
    settings: {
      bgmVolume: num(settings.bgmVolume, DEFAULT_SETTINGS.bgmVolume),
      seVolume: num(settings.seVolume, DEFAULT_SETTINGS.seVolume),
      colorMode:
        settings.colorMode === 'high-contrast' || settings.colorMode === 'mono'
          ? settings.colorMode
          : DEFAULT_SETTINGS.colorMode,
    },
    difficulty,
    records: {
      solo: {
        bestScore: num(solo.bestScore, 0),
        bestMaxChain: num(solo.bestMaxChain, 0),
        totalCleared: num(solo.totalCleared, 0),
        bestScoreAt: typeof solo.bestScoreAt === 'string' ? solo.bestScoreAt : null,
      },
      online: Array.isArray(records.online)
        ? records.online.filter(isHistoryEntry).slice(0, HISTORY_LIMIT)
        : EMPTY_RECORDS.online,
    },
    updatedAt: typeof d.updatedAt === 'string' ? d.updatedAt : new Date(0).toISOString(),
  };
}

function isHistoryEntry(v: unknown): v is OnlineHistoryEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.at === 'string' &&
    typeof e.opponentNickname === 'string' &&
    (e.outcome === 'win' || e.outcome === 'loss' || e.outcome === 'draw') &&
    typeof e.selfScore === 'number'
  );
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/* -------------------------------- seq --------------------------------- */

function readSeq(): number {
  if (typeof window === 'undefined' || !window.localStorage) return 0;
  const raw = window.localStorage.getItem(SEQ_KEY);
  const n = raw === null ? 0 : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function writeSeq(seq: number): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(SEQ_KEY, String(seq));
  } catch {
    /* ignore */
  }
}

/**
 * Called on logout so the next account doesn't inherit our sequence —
 * and so nothing on this device keeps pushing to the account that just
 * left.
 */
export function resetSeq(): void {
  cloudEnabled = false;
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.removeItem(SEQ_KEY);
  } catch {
    /* ignore */
  }
}

/* ------------------------------- syncing ------------------------------ */

let inFlight: Promise<SyncOutcome> | null = null;
/** True once a sync has proved this account has cloud storage. */
let cloudEnabled = false;
/** Set while `applyPayload` writes, to break the echo loop. */
let suppressed = false;

/**
 * Pull, merge, apply locally, push back. Safe to call repeatedly —
 * concurrent callers share the one in-flight run.
 */
export function syncNow(): Promise<SyncOutcome> {
  if (inFlight) return inFlight;
  inFlight = runSync().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runSync(): Promise<SyncOutcome> {
  try {
    const envelope = await fetchCloudSave<unknown>();
    const local = snapshotLocal();

    if (envelope === null) {
      // First sync for this account — seed it with what's on this device.
      await write(local, 1);
      cloudEnabled = true;
      return 'synced';
    }

    const remote = normalizePayload(envelope.payload);
    if (remote === null) {
      await write(local, envelope.save_seq + 1);
      cloudEnabled = true;
      return 'synced';
    }

    const merged = mergePayloads(local, remote);
    applyPayload(merged);
    await write(merged, envelope.save_seq + 1);
    cloudEnabled = true;
    return 'synced';
  } catch (err) {
    if (isNotLinked(err)) {
      cloudEnabled = false;
      return 'not-linked';
    }
    console.warn('[cloud] sync failed', err);
    return 'failed';
  }
}

/**
 * Push, and on a lost race merge the winner in and push once more.
 * One retry is enough in practice; a second conflict means another
 * device is actively writing, and the next sync will pick it up.
 */
async function write(payload: CloudSavePayload, seq: number): Promise<void> {
  try {
    const res = await pushCloudSave(payload, seq);
    writeSeq(res.save_seq);
  } catch (err) {
    if (!(err instanceof CloudConflictError)) throw err;
    const winner = normalizePayload(err.current?.payload);
    const nextSeq = (err.current?.save_seq ?? seq) + 1;
    const merged = winner ? mergePayloads(payload, winner) : payload;
    applyPayload(merged);
    const res = await pushCloudSave(merged, nextSeq);
    writeSeq(res.save_seq);
  }
}

function isNotLinked(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    ((err as { code: string }).code === 'NOT_LINKED' ||
      (err as { code: string }).code === 'UNAUTHENTICATED')
  );
}

/* ------------------------------ scheduling ---------------------------- */

let pushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Queue a background push after local state changed. Debounced, and a
 * failure is swallowed — cloud save is a convenience, never a reason
 * to interrupt play.
 */
export function scheduleCloudPush(): void {
  if (pushTimer !== null) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void pushLocal();
  }, PUSH_DEBOUNCE_MS);
}

async function pushLocal(): Promise<void> {
  try {
    await write(snapshotLocal(), readSeq() + 1);
  } catch (err) {
    if (isNotLinked(err)) {
      cloudEnabled = false;
      return;
    }
    console.warn('[cloud] push failed', err);
  }
}

// Any localStorage write by the game queues a push — but only once we
// know the account actually has cloud storage. Guests and unlinked
// players never hit the network.
onLocalStateChanged(() => {
  if (suppressed || !cloudEnabled) return;
  scheduleCloudPush();
});
