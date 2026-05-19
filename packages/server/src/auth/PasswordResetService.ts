/**
 * PasswordResetService — token lifecycle for the "forgot password"
 * flow.
 *
 * Lifecycle:
 *   1. `request(email)` looks up the user, mints a random token,
 *      stores a bcrypt hash of it in `password_resets` with a 1-hour
 *      TTL, and hands the plaintext token to the caller so the
 *      route handler can hand it off to the EmailSender. Returns
 *      `null` for unknown emails — we deliberately don't surface
 *      "no such user" to the caller, so an attacker can't probe
 *      whether an address is registered.
 *
 *   2. `confirm(token, newPassword)` scans pending rows that haven't
 *      expired or been used, bcrypt-compares each hash against the
 *      submitted token, and on match rewrites `users.password_hash`
 *      + marks the row consumed. Returns the affected userId on
 *      success or `null` otherwise.
 *
 * The plaintext token never lives in the DB, so leaking the table
 * doesn't grant the attacker entry. The bcrypt scan is O(pending) —
 * we keep the index clean by deleting expired rows opportunistically.
 */

import { randomBytes } from 'node:crypto';
import { compareSync, hashSync } from 'bcryptjs';
import type { Database } from 'better-sqlite3';

const TOKEN_BYTES = 32;
const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const BCRYPT_COST = 10;
const MIN_PASSWORD = 8;
const PASSWORD_PATTERN = /^[A-Za-z0-9!@#$%^&*()_\-+=.]+$/;

export interface ResetRequestResult {
  /** Plaintext token to put in the e-mail. Never persisted in the DB. */
  token: string;
  /** Public-facing user id, useful for the e-mail copy. */
  userId: string;
  /** Display name to greet the user in the e-mail body. */
  playerName: string;
  /** ISO timestamp the request expires. */
  expiresAt: string;
}

export type ResetConfirmError = 'INVALID_TOKEN' | 'INVALID_PASSWORD';

export class PasswordResetService {
  constructor(private readonly db: Database) {}

  /** Step 1: create + persist a token. */
  request(email: string): ResetRequestResult | null {
    const user = this.db
      .prepare('SELECT id, user_id, player_name FROM users WHERE email = ?')
      .get(email.trim()) as { id: number; user_id: string; player_name: string } | undefined;
    if (!user) return null;

    // Best-effort cleanup so the bcrypt-compare scan inside confirm()
    // stays short. Failures are non-fatal — the TTL is enforced again
    // at confirm time.
    this.db
      .prepare(
        `DELETE FROM password_resets
         WHERE user_id = ? AND (expires_at < ? OR used_at IS NOT NULL)`,
      )
      .run(user.id, new Date().toISOString());

    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const tokenHash = hashSync(token, BCRYPT_COST);
    const now = new Date();
    const expires = new Date(now.getTime() + TOKEN_TTL_MS);
    this.db
      .prepare(
        `INSERT INTO password_resets (user_id, token_hash, expires_at, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(user.id, tokenHash, expires.toISOString(), now.toISOString());
    return {
      token,
      userId: user.user_id,
      playerName: user.player_name,
      expiresAt: expires.toISOString(),
    };
  }

  /** Step 2: redeem a token and rotate the password. */
  confirm(token: string, newPassword: string): { userId: string } | { error: ResetConfirmError } {
    if (!PASSWORD_PATTERN.test(newPassword) || newPassword.length < MIN_PASSWORD) {
      return { error: 'INVALID_PASSWORD' };
    }
    const now = new Date().toISOString();
    const rows = this.db
      .prepare(
        `SELECT pr.id            AS resetId,
                pr.user_id        AS userId,
                pr.token_hash     AS tokenHash,
                u.user_id         AS publicUserId
         FROM password_resets pr
         JOIN users u ON u.id = pr.user_id
         WHERE pr.expires_at > ? AND pr.used_at IS NULL
         ORDER BY pr.id DESC
         LIMIT 50`,
      )
      .all(now) as Array<{
      resetId: number;
      userId: number;
      tokenHash: string;
      publicUserId: string;
    }>;
    for (const row of rows) {
      if (!compareSync(token, row.tokenHash)) continue;
      // Match. Mint the new password hash + consume the row inside
      // one statement-pair so a concurrent retry can't double-use the
      // token.
      const updated = this.db
        .prepare(
          `UPDATE password_resets
           SET used_at = ?
           WHERE id = ? AND used_at IS NULL`,
        )
        .run(now, row.resetId);
      if (updated.changes === 0) continue;
      const passwordHash = hashSync(newPassword, BCRYPT_COST);
      this.db
        .prepare(
          `UPDATE users
           SET password_hash = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(passwordHash, now, row.userId);
      return { userId: row.publicUserId };
    }
    return { error: 'INVALID_TOKEN' };
  }
}
