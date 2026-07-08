/**
 * SQLite handle factory.
 *
 * `:memory:` is the test default — no file is touched, and each suite
 * gets its own isolated in-memory DB. Production points the
 * `DATABASE_PATH` env var at a path on the persistent volume.
 *
 * We enable foreign-key enforcement explicitly because better-sqlite3
 * (and SQLite generally) leaves it off by default.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import BetterSqlite3, { type Database } from 'better-sqlite3';
import { applySchema } from './schema';

export interface OpenDbOptions {
  path?: string;
  /** When true (default in tests) opens an in-memory DB and applies the
   *  schema immediately. */
  inMemory?: boolean;
}

export function openDatabase(opts: OpenDbOptions = {}): Database {
  const target = opts.inMemory ? ':memory:' : (opts.path ?? ':memory:');
  // better-sqlite3 refuses to create the DB file if its parent directory
  // is missing ("Cannot open database because the directory does not
  // exist"). On a fresh volume mount (or a container with no volume yet)
  // the target dir may not exist, so create it — this turns a hard boot
  // crash into a self-healing start.
  if (target !== ':memory:') {
    try {
      mkdirSync(dirname(target), { recursive: true });
    } catch {
      /* best-effort; if it truly can't be created the open below throws */
    }
  }
  const db = new BetterSqlite3(target);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  return db;
}
