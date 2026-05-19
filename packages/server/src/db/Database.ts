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
  const db = new BetterSqlite3(target);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  return db;
}
