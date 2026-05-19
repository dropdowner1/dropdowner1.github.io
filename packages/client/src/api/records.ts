/**
 * /api/records/* + /api/rankings/* wrappers.
 *
 * Records writes are silent when they fail — losing a record is
 * regrettable but not show-stopping, so we never propagate the
 * exception into the match/result flow. Logs go to `console.warn`.
 */

import type {
  OnlineMatchRequest,
  OnlineRankingsResponse,
  RecordsMeResponse,
  SoloRankingsResponse,
  SoloRunRequest,
} from '@chaindrop/shared/protocol';
import { http } from './http';

export async function postSoloRun(run: SoloRunRequest): Promise<void> {
  try {
    await http.post<void>('/api/records/solo', run);
  } catch (err) {
    console.warn('[records] failed to persist solo run', err);
  }
}

export async function postOnlineMatch(match: OnlineMatchRequest): Promise<void> {
  try {
    await http.post<void>('/api/records/online', match);
  } catch (err) {
    console.warn('[records] failed to persist online match', err);
  }
}

export async function fetchMyRecords(): Promise<RecordsMeResponse | null> {
  try {
    return await http.get<RecordsMeResponse>('/api/records/me');
  } catch {
    return null;
  }
}

export async function fetchSoloRankings(): Promise<SoloRankingsResponse> {
  return http.get<SoloRankingsResponse>('/api/rankings/solo');
}

export async function fetchOnlineRankings(): Promise<OnlineRankingsResponse> {
  return http.get<OnlineRankingsResponse>('/api/rankings/online');
}
