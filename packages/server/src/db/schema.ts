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
  -- email is intentionally optional / not surfaced through the API.
  -- The column is kept so adding an e-mail-based recovery flow later
  -- doesn't require a migration. NULL is fine for every account today.
  email         TEXT,
  password_hash TEXT    NOT NULL,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_user_id ON users(user_id);

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

-- External identity links (Techmana SSO). Deliberately a separate table
-- rather than extra columns on the users table: the DDL above is
-- CREATE TABLE IF NOT EXISTS, so adding a column there would silently
-- do nothing on a database that already exists (i.e. production). A
-- brand-new table IS created on the next boot, so this lands without a
-- migration runner.
--
-- Provider tokens live here so the browser never sees them; the server
-- calls Techmana on the player's behalf.
CREATE TABLE IF NOT EXISTS oauth_links (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider       TEXT    NOT NULL,
  subject        TEXT    NOT NULL,
  access_token   TEXT,
  refresh_token  TEXT,
  expires_at     TEXT,
  scope          TEXT,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL,
  UNIQUE (provider, subject),
  UNIQUE (provider, user_id)
);

CREATE INDEX IF NOT EXISTS idx_oauth_links_user ON oauth_links(user_id);
`;

export function applySchema(db: Database): void {
  db.exec(DDL);
}
