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

/**
 * Hard ceiling on a single request. The Railway free tier cold-starts
 * in up to ~30s, so we allow that much before giving up — but we DO
 * give up, instead of leaving the UI on a spinner forever when the
 * server is genuinely down.
 */
const REQUEST_TIMEOUT_MS = 30_000;

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
    /**
     * The parsed error body, when the server sent one. Some responses
     * carry data the caller needs to recover — a 409 from the cloud
     * save, for instance, includes the newer copy that won.
     */
    public readonly body?: unknown,
  ) {
    super(`${code}: ${message}`);
    this.name = 'HttpApiError';
  }
}

async function call<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
  // Build the RequestInit dynamically so the `body` property is
  // entirely absent when there's nothing to send — under
  // exactOptionalPropertyTypes, fetch refuses to take `undefined` as
  // a value for body.
  const init: RequestInit = { method, credentials: 'include' };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  // Abort the request if it outruns the timeout, and translate both the
  // timeout and a raw network failure (offline, DNS, refused) into a
  // typed HttpApiError so callers get a clean Japanese message instead
  // of a raw TypeError or an indefinite hang.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  init.signal = controller.signal;
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, init);
  } catch {
    clearTimeout(timer);
    if (controller.signal.aborted) {
      throw new HttpApiError(
        0,
        'TIMEOUT',
        'サーバの応答がありません。時間をおいて再度お試しください',
      );
    }
    throw new HttpApiError(0, 'NETWORK', 'サーバに接続できませんでした');
  }
  clearTimeout(timer);
  if (res.status === 204) return undefined as unknown as T;
  const text = await res.text();
  const json = text ? safeJson(text) : undefined;
  if (!res.ok) {
    const code = (json as { error?: string } | undefined)?.error ?? `HTTP_${res.status}`;
    const message =
      (json as { message?: string } | undefined)?.message ?? res.statusText ?? 'request failed';
    throw new HttpApiError(res.status, code, message, json);
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
  put: <T>(path: string, body?: unknown) => call<T>('PUT', path, body),
};

/**
 * The resolved API origin. Needed for flows that hand the browser to
 * the server directly (OAuth), where `fetch` is not involved.
 */
export const apiBase = API_BASE;
