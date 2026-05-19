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
   * Public URL of the client. Used to build the
   * `#reset/<token>` deep-link inside password-reset emails. Defaults
   * to the local Vite dev origin so a developer can test the flow
   * without setting anything up.
   */
  clientBaseUrl: process.env.CLIENT_BASE_URL ?? 'http://localhost:5173',
} as const;
