/**
 * Server runtime configuration, sourced from environment variables.
 * See D6 §4.1 and D10 §13.2.
 */

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.toLowerCase() === 'true' || value === '1';
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  port: parseNumber(process.env.PORT, 2567),
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  maxRooms: parseNumber(process.env.MAX_ROOMS, 100),
  monitor: {
    enabled: parseBool(process.env.MONITOR_ENABLED, false),
    user: process.env.MONITOR_USER ?? 'admin',
    pass: process.env.MONITOR_PASS ?? '',
  },
  /**
   * SQLite location. `:memory:` (the default in dev/test) starts
   * with a clean DB on every process boot. Production should set
   * this to a path on a persistent volume.
   */
  databasePath: process.env.DATABASE_PATH ?? ':memory:',
  /**
   * Optional `domain` attribute for the session cookie. Leave unset
   * (the default) for first-party deployments; only set this if the
   * client and server share a parent domain and you need the cookie
   * to span subdomains.
   */
  cookieDomain: process.env.COOKIE_DOMAIN ?? undefined,
  /**
   * Where to send the browser back to after an OAuth round-trip. The
   * SPA has no router, so we always land on its root and let the
   * session cookie do the rest.
   */
  clientBaseUrl: (process.env.CLIENT_BASE_URL ?? 'https://dropdowner1.github.io/').trim(),
  /**
   * Techmana SSO (テクマナ). Optional: when `clientId`/`clientSecret`
   * are unset the feature is simply off and the routes report it,
   * rather than the process failing to boot — a missing SSO config
   * must never take the game down.
   */
  techmana: {
    baseUrl: (process.env.TECHMANA_BASE_URL ?? 'https://techmana.adamant-group.jp').replace(
      /\/$/,
      '',
    ),
    clientId: process.env.TECHMANA_CLIENT_ID ?? '',
    clientSecret: process.env.TECHMANA_CLIENT_SECRET ?? '',
    /** Must match the value registered in Techmana byte-for-byte. */
    redirectUri: process.env.TECHMANA_REDIRECT_URI ?? '',
  },
} as const;

/** True when Techmana SSO has everything it needs to run. */
export function techmanaEnabled(): boolean {
  const t = config.techmana;
  return t.clientId !== '' && t.clientSecret !== '' && t.redirectUri !== '';
}
