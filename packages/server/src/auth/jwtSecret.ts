/**
 * Returns the secret used to sign session JWTs.
 *
 * Production must set `JWT_SECRET`. In dev we fall back to a stable
 * per-process random secret so cookies issued before a reload are
 * invalidated (you get logged out across server restarts, which is
 * fine on a dev box).
 */

import { randomBytes } from 'node:crypto';

let cached: string | null = null;

export function jwtSecret(): string {
  if (cached) return cached;
  const env = process.env.JWT_SECRET;
  if (env && env.length >= 16) {
    cached = env;
    return cached;
  }
  cached = randomBytes(48).toString('hex');
  return cached;
}

/** Test helper to reset the cached secret between suites. */
export function _resetJwtSecretForTesting(): void {
  cached = null;
}
