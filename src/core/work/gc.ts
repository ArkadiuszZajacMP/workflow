import { and, eq, inArray, lt, ne } from 'drizzle-orm';
import type { Db } from '../db/client';
import { items, workspaces } from '../db/schema';
import { writeTransaction } from '../db/tx';
import { enqueueJob, hasActiveJob } from '../jobs/queue';

const DAY_MS = 86_400_000;

/** Enqueues `remove-workspace` for items done or dismissed for longer than the retention. Returns how many. */
export function enqueueWorkspaceGc(db: Db, retentionDays: number, now = Date.now()): number {
  return writeTransaction(db, (tx) => {
    const rows = tx
      .select({ itemId: workspaces.itemId })
      .from(workspaces)
      .innerJoin(items, eq(items.id, workspaces.itemId))
      .where(
        and(
          ne(workspaces.status, 'removed'),
          inArray(items.category, ['done', 'dismissed']),
          lt(items.updatedAt, now - retentionDays * DAY_MS),
        ),
      )
      .all();
    let queued = 0;
    for (const { itemId } of rows) {
      if (hasActiveJob(tx, itemId)) continue;
      enqueueJob(tx, 'remove-workspace', itemId, {}, now);
      queued++;
    }
    return queued;
  });
}
