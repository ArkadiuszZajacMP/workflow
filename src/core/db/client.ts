import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import { errorMessage } from '../errors';
import * as schema from './schema';

export type Db = BaseSQLiteDatabase<'sync', Database.RunResult, typeof schema>;

const MIGRATIONS_FOLDER = path.join(process.cwd(), 'src/core/db/migrations');

export function openDb(file: string): Db {
  mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  try {
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  } catch (err) {
    // The web app and the worker can start together. If the other process applied the
    // migration first, ours fails with "already exists". Its migration is recorded now, so retry once.
    if (!/already exists/i.test(errorMessage(err))) throw err;
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  }
  return db;
}

export function defaultDbPath(): string {
  return process.env.WORKFLOW_DB ?? path.join(process.cwd(), 'data', 'workflow.db');
}

const globalForDb = globalThis as unknown as { workflowDb?: Db };

/** Process-wide connection. Cached on globalThis so Next.js hot reloads reuse it. */
export function getDb(): Db {
  globalForDb.workflowDb ??= openDb(defaultDbPath());
  return globalForDb.workflowDb;
}
