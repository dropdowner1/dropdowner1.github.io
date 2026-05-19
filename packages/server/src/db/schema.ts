/**
 * SQLite schema, applied idempotently at boot. We don't have enough
 * surface area to justify a migration framework yet — every table
 * declaration is `CREATE TABLE IF NOT EXISTS` so re-runs are no-ops.
 *
 * When the schema starts evolving we'll bump to a per-statement
 * migration list versioned by a `schema_version` table.
 */

import type { Database } from 'better-sqlite3';

const DDL = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT    UNIQUE NOT NULL,
  player_name   TEXT    NOT NULL,
  email         TEXT    UNIQUE NOT NULL,
  password_hash TEXT    NOT NULL,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_user_id ON users(user_id);
CREATE INDEX IF NOT EXISTS idx_users_email   ON users(email);

CREATE TABLE IF NOT EXISTS solo_runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score          INTEGER NOT NULL,
  max_chain      INTEGER NOT NULL,
  cells_cleared  INTEGER NOT NULL,
  played_at      TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_solo_runs_score ON solo_runs(score DESC);
CREATE INDEX IF NOT EXISTS idx_solo_runs_user  ON solo_runs(user_id, played_at DESC);

CREATE TABLE IF NOT EXISTS match_history (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  opponent_name  TEXT    NOT NULL,
  outcome        TEXT    NOT NULL CHECK (outcome IN ('win','loss','draw')),
  self_score     INTEGER NOT NULL,
  played_at      TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_match_user ON match_history(user_id, played_at DESC);

CREATE TABLE IF NOT EXISTS password_resets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- bcrypt hash of the token; the plaintext token only ever leaves
  -- through the e-mail body so leaking the DB row can't grant entry.
  token_hash  TEXT    NOT NULL,
  expires_at  TEXT    NOT NULL,
  used_at     TEXT,
  created_at  TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_password_resets_user
  ON password_resets(user_id, created_at DESC);
`;

export function applySchema(db: Database): void {
  db.exec(DDL);
}
