import type { Db } from './client';

/**
 * Runs `fn` in a BEGIN IMMEDIATE transaction. Taking the write lock up front means a
 * concurrent writer makes us wait (busy_timeout) instead of failing with SQLITE_BUSY
 * when a deferred read transaction tries to upgrade to a write.
 */
export function writeTransaction<T>(db: Db, fn: (tx: Db) => T): T {
  return db.transaction((tx) => fn(tx), { behavior: 'immediate' });
}
