import { eq } from 'drizzle-orm';
import type { Db } from './db/client';
import { type PollCursor, pollCursors } from './db/schema';

export type PollSource = 'slack' | 'linear' | 'config';

export function getCursor(db: Db, source: PollSource): PollCursor | undefined {
  return db.select().from(pollCursors).where(eq(pollCursors.source, source)).get();
}

export function listCursors(db: Db): PollCursor[] {
  return db.select().from(pollCursors).all();
}

export function recordPollSuccess(db: Db, source: PollSource, cursor: string | null, now = Date.now()): void {
  db.insert(pollCursors)
    .values({ source, cursor, lastSuccessAt: now, lastError: null, lastErrorAt: null })
    .onConflictDoUpdate({
      target: pollCursors.source,
      set: { cursor, lastSuccessAt: now, lastError: null, lastErrorAt: null },
    })
    .run();
}

/** Keeps the cursor so the next cycle re-reads the same window. */
export function recordPollError(db: Db, source: PollSource, message: string, now = Date.now()): void {
  db.insert(pollCursors)
    .values({ source, lastError: message, lastErrorAt: now })
    .onConflictDoUpdate({ target: pollCursors.source, set: { lastError: message, lastErrorAt: now } })
    .run();
}
