/**
 * Tiny wrapper around `fetch` for the HTTP API.
 *
 * The server URL comes from `VITE_API_URL` (or falls back to the
 * Colyseus URL stripped of its ws:// scheme — they share a host in
 * development). All requests opt in to credentials so the
 * HttpOnly session cookie travels both ways.
 *
 * Responses that come back non-2xx are surfaced as a typed
 * `ApiError`; routes that need request-body validation should
 * `zod.safeParse(await res.json())` before using the payload.
 */

const RAW_SERVER_URL = (
  import.meta.env.VITE_API_URL ||
  import.meta.env.VITE_SERVER_URL ||
  ''
).trim();

/** Resolve once at module load. Empty/invalid → `http://localhost:2567`. */
function resolveBase(): string {
  const fallback = 'http://localhost:2567';
  if (!RAW_SERVER_URL) return fallback;
  try {
    const u = new URL(RAW_SERVER_URL);
    // Colyseus tends to be given as ws://; rewrite to http(s) for the
    // REST API which lives on the same host/port.
    if (u.protocol === 'ws:') u.protocol = 'http:';
    else if (u.protocol === 'wss:') u.protocol = 'https:';
    return u.toString().replace(/\/$/, '');
  } catch {
    return fallback;
  }
}

const API_BASE = resolveBase();

export interface ApiError {
  status: number;
  code: string;
  message: string;
}

export class HttpApiError extends Error implements ApiError {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public override readonly message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'HttpApiError';
  }
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  // Build the RequestInit dynamically so the `body` property is
  // entirely absent when there's nothing to send — under
  // exactOptionalPropertyTypes, fetch refuses to take `undefined` as
  // a value for body.
  const init: RequestInit = { method, credentials: 'include' };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${API_BASE}${path}`, init);
  if (res.status === 204) return undefined as unknown as T;
  const text = await res.text();
  const json = text ? safeJson(text) : undefined;
  if (!res.ok) {
    const code = (json as { error?: string } | undefined)?.error ?? `HTTP_${res.status}`;
    const message =
      (json as { message?: string } | undefined)?.message ?? res.statusText ?? 'request failed';
    throw new HttpApiError(res.status, code, message);
  }
  return (json ?? {}) as T;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

export const http = {
  get: <T>(path: string) => call<T>('GET', path),
  post: <T>(path: string, body?: unknown) => call<T>('POST', path, body),
};
