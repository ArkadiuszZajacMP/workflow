import { eq } from 'drizzle-orm';
import type { LinearClient, LinearIssueState } from '@/core/clients/types';
import type { Config } from '@/core/config/schema';
import { getCursor, recordPollSuccess } from '@/core/cursors';
import type { Db } from '@/core/db/client';
import { type LinearIssueSnapshot, linearIssueSnapshots } from '@/core/db/schema';
import { type LinearLabelEvent, type LinearStatusEvent, linearEventKey } from '@/core/events';
import { ingestEvent } from '@/core/ingest';
import { writeTransaction } from '@/core/db/tx';

export function diffIssue(
  snapshot: LinearIssueSnapshot | undefined,
  issue: LinearIssueState,
): { event: LinearStatusEvent | LinearLabelEvent; key: string }[] {
  const ref = { id: issue.id, identifier: issue.identifier, title: issue.title, url: issue.url };
  const events: (LinearStatusEvent | LinearLabelEvent)[] = [];
  if (!snapshot || snapshot.statusName !== issue.status) {
    events.push({ source: 'linear', kind: 'status_changed', issue: ref, status: issue.status });
  }
  const before = new Set(snapshot?.labelNames ?? []);
  for (const label of issue.labels) {
    if (!before.has(label)) events.push({ source: 'linear', kind: 'label_added', issue: ref, label });
  }
  return events.map((event) => ({ event, key: linearEventKey(event, issue.updatedAt) }));
}

function getSnapshot(db: Db, issueId: string): LinearIssueSnapshot | undefined {
  return db.select().from(linearIssueSnapshots).where(eq(linearIssueSnapshots.issueId, issueId)).get();
}

function saveSnapshot(db: Db, issue: LinearIssueState): void {
  const values = { statusName: issue.status, labelNames: issue.labels, updatedAt: issue.updatedAt };
  db.insert(linearIssueSnapshots)
    .values({ issueId: issue.id, ...values })
    .onConflictDoUpdate({ target: linearIssueSnapshots.issueId, set: values })
    .run();
}

/**
 * Fetches the user's issues updated at or after the cursor (inclusive, so same-millisecond
 * updates are not lost) and turns snapshot differences into events.
 */
export async function pollLinear(
  deps: { db: Db; linear: LinearClient; config: Config },
  now = Date.now(),
): Promise<{ newEvents: number }> {
  const { db, linear, config } = deps;
  const since = getCursor(db, 'linear')?.cursor ?? null;
  let newest = since;
  let newEvents = 0;
  let after: string | undefined;

  do {
    const page = await linear.listMyIssuesUpdatedSince(since, after);
    for (const issue of page.issues) {
      writeTransaction(db, (tx) => {
        for (const { event, key } of diffIssue(getSnapshot(tx, issue.id), issue)) {
          if (ingestEvent(tx, event, key, config.rules, now).inserted) newEvents++;
        }
        saveSnapshot(tx, issue);
      });
      if (!newest || issue.updatedAt > newest) newest = issue.updatedAt;
    }
    after = page.hasNextPage && page.endCursor ? page.endCursor : undefined;
  } while (after);

  // An empty first poll still ends first-run mode, so later polls ask only for changes since now.
  recordPollSuccess(db, 'linear', newest ?? new Date(now).toISOString(), now);
  return { newEvents };
}
