import { count, desc, eq, ne } from 'drizzle-orm';
import { listCursors } from './cursors';
import type { Db } from './db/client';
import { type Activity, type Category, type Draft, type DuplicateCandidate, type Item, items, jobs, type PollCursor } from './db/schema';
import { listDrafts, listDuplicateCandidates } from './drafts';
import { getItem, listActivity } from './items';
import { hasActiveJob } from './jobs/queue';

export function listItems(db: Db, opts: { category?: Category } = {}): Item[] {
  const where = opts.category ? eq(items.category, opts.category) : ne(items.category, 'dismissed');
  return db.select().from(items).where(where).orderBy(desc(items.updatedAt), desc(items.id)).all();
}

export type ItemDetail = {
  item: Item;
  drafts: Draft[];
  candidates: DuplicateCandidate[];
  activity: Activity[];
  activeJob: boolean;
};

export function getItemDetail(db: Db, id: number): ItemDetail | null {
  const item = getItem(db, id);
  if (!item) return null;
  return {
    item,
    drafts: listDrafts(db, id),
    candidates: listDuplicateCandidates(db, id),
    activity: listActivity(db, id),
    activeJob: hasActiveJob(db, id),
  };
}

export type QueueStatus = { polls: PollCursor[]; queuedJobs: number; failedJobs: number };

export function getQueueStatus(db: Db): QueueStatus {
  const countStatus = (status: 'queued' | 'failed') =>
    db.select({ n: count() }).from(jobs).where(eq(jobs.status, status)).get()?.n ?? 0;
  return { polls: listCursors(db), queuedJobs: countStatus('queued'), failedJobs: countStatus('failed') };
}
