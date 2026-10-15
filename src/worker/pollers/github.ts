import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { prKey } from '@/core/clients/github';
import type { GitHubClient } from '@/core/clients/types';
import { recordPollSuccess } from '@/core/cursors';
import type { Db } from '@/core/db/client';
import { items, plannedPrs } from '@/core/db/schema';
import { updatePlannedPr } from '@/core/work/planned-prs';

/** Refreshes draft/merged, unresolved threads and CI state for open PRs of items still in implementation. */
export async function pollGithub(deps: { db: Db; github: GitHubClient }, now = Date.now()): Promise<{ updated: number }> {
  const rows = deps.db
    .select({ id: plannedPrs.id, repo: plannedPrs.githubRepo, number: plannedPrs.prNumber })
    .from(plannedPrs)
    .innerJoin(items, eq(items.id, plannedPrs.itemId))
    .where(and(eq(plannedPrs.state, 'open'), isNotNull(plannedPrs.prNumber), inArray(items.workState, ['implementing', 'prs_open'])))
    .all();
  let updated = 0;
  if (rows.length > 0) {
    const statuses = await deps.github.prStatuses(rows.map((r) => ({ repo: r.repo, number: r.number! })));
    for (const row of rows) {
      const status = statuses.get(prKey(row.repo, row.number!));
      if (!status) continue;
      updatePlannedPr(
        deps.db,
        row.id,
        { isDraft: status.isDraft, merged: status.merged, unresolvedThreads: status.unresolvedThreads, ciState: status.ciState, polledAt: now },
        now,
      );
      updated++;
    }
  }
  recordPollSuccess(deps.db, 'github', null, now);
  return { updated };
}
