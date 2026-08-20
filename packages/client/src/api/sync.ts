/**
 * /api/auth/techmana/* + /api/sync/* wrappers.
 *
 * Techmana (テクマナ) is the account provider; ChainDrop's own server
 * is the only thing that ever holds a Techmana token, so from the
 * browser's point of view these are plain calls authenticated by the
 * usual ChainDrop session cookie.
 */

import { http, HttpApiError, apiBase } from './http';

export interface TechmanaStatus {
  linked: boolean;
  subject: string | null;
  /** False when the server has no Techmana credentials configured. */
  enabled: boolean;
}

/** Shape returned by Techmana for a stored slot. */
export interface CloudSaveEnvelope<T = unknown> {
  slot: string;
  payload: T;
  save_seq: number;
  payload_hash: string;
  updated_at: string;
}

export interface CloudWriteResult {
  ok: true;
  slot: string;
  save_seq: number;
  payload_hash: string;
  size_bytes: number;
}

/** Thrown when another device already wrote a newer save. */
export class CloudConflictError extends Error {
  constructor(readonly current: CloudSaveEnvelope | null) {
    super('cloud save conflict');
    this.name = 'CloudConflictError';
  }
}

/**
 * Where to send the browser to begin the Techmana hand-off. This is a
 * full page navigation, not a fetch — the server needs to set a cookie
 * and redirect, which XHR cannot do.
 */
export function techmanaStartUrl(): string {
  return `${apiBase}/api/auth/techmana/start`;
}

export async function fetchTechmanaStatus(): Promise<TechmanaStatus> {
  try {
    return await http.get<TechmanaStatus>('/api/auth/techmana/status');
  } catch (err) {
    if (err instanceof HttpApiError && err.status === 401) {
      return { linked: false, subject: null, enabled: true };
    }
    throw err;
  }
}

export async function unlinkTechmana(): Promise<void> {
  await http.post<void>('/api/auth/techmana/unlink');
}

/**
 * @returns `null` when the account has no cloud save yet.
 * @throws when the account isn't linked — that is a different situation
 *         from an empty save, and seeding a save for an unlinked account
 *         would just fail on the write instead.
 */
export async function fetchCloudSave<T>(): Promise<CloudSaveEnvelope<T> | null> {
  try {
    return await http.get<CloudSaveEnvelope<T>>('/api/sync/save');
  } catch (err) {
    if (err instanceof HttpApiError && err.status === 404) return null;
    throw err;
  }
}

/**
 * Write the cloud save.
 *
 * `saveSeq` must be strictly greater than whatever is stored, which is
 * how Techmana keeps a stale device from clobbering a newer save. A
 * losing write raises `CloudConflictError` carrying the copy that won,
 * so the caller can merge and retry rather than silently lose data.
 */
export async function pushCloudSave<T>(payload: T, saveSeq: number): Promise<CloudWriteResult> {
  try {
    return await http.put<CloudWriteResult>('/api/sync/save', { payload, saveSeq });
  } catch (err) {
    // Match on the code, not the bare status — a 409 that isn't a lost
    // race must not be retried as if merging would fix it.
    if (err instanceof HttpApiError && err.status === 409 && err.code === 'CONFLICT') {
      const body = err.body as { current?: CloudSaveEnvelope } | undefined;
      throw new CloudConflictError(body?.current ?? null);
    }
    throw err;
  }
}
