import { and, eq, inArray, isNotNull, isNull, ne, notInArray, or } from 'drizzle-orm';
import { prKey } from '@/core/clients/github';
import type { GitHubClient } from '@/core/clients/types';
import { recordPollError, recordPollSuccess } from '@/core/cursors';
import type { Db } from '@/core/db/client';
import { items, plannedPrs } from '@/core/db/schema';
import { TransientError, errorMessage } from '@/core/errors';
import { writeTransaction } from '@/core/db/tx';
import { logActivity } from '@/core/items';
import { PR_CLOSED_ERROR, updatePlannedPr } from '@/core/work/planned-prs';

type Row = { id: number; itemId: number; repo: string; number: number };

/**
 * Refreshes draft/merged, unresolved threads and CI state for open, unmerged PRs of items still in implementation.
 * A PR merged or closed on GitHub is recorded (merged, or `PR_CLOSED_ERROR`) and not polled again.
 * PRs are fetched one repo at a time so a failing repo (SSO, archived, forbidden) cannot block the others.
 * `intervalMs` is the normal poll interval; a rate-limit `retryAfterMs` longer than it delays the next attempt.
 */
export async function pollGithub(
  deps: { db: Db; github: GitHubClient; intervalMs?: number },
  now = Date.now(),
): Promise<{ updated: number; failed: number }> {
  const rows: Row[] = deps.db
    .select({ id: plannedPrs.id, itemId: plannedPrs.itemId, repo: plannedPrs.githubRepo, number: plannedPrs.prNumber })
    .from(plannedPrs)
    .innerJoin(items, eq(items.id, plannedPrs.itemId))
    .where(
      and(
        eq(plannedPrs.state, 'open'),
        eq(plannedPrs.merged, false),
        or(isNull(plannedPrs.lastError), ne(plannedPrs.lastError, PR_CLOSED_ERROR)),
        isNotNull(plannedPrs.prNumber),
        inArray(items.workState, ['implementing', 'prs_open']),
        notInArray(items.category, ['done', 'dismissed']),
      ),
    )
    .all()
    .map((r) => ({ id: r.id, itemId: r.itemId, repo: r.repo, number: r.number! }));

  const byRepo = new Map<string, Row[]>();
  for (const row of rows) byRepo.set(row.repo, [...(byRepo.get(row.repo) ?? []), row]);

  let updated = 0;
  let failed = 0;
  let firstError: string | null = null;
  let retryAfterMs = 0;
  for (const chunk of byRepo.values()) {
    try {
      const statuses = await deps.github.prStatuses(chunk.map((r) => ({ repo: r.repo, number: r.number })));
      updated += writeTransaction(deps.db, (tx) => {
        let count = 0;
        for (const row of chunk) {
          const status = statuses.get(prKey(row.repo, row.number));
          if (!status) continue;
          const merged = status.merged || status.state === 'MERGED';
          const closed = !merged && status.state === 'CLOSED';
          updatePlannedPr(
            tx,
            row.id,
            {
              isDraft: status.isDraft,
              merged,
              unresolvedThreads: status.unresolvedThreads,
              ciState: status.ciState,
              polledAt: now,
              ...(closed ? { lastError: PR_CLOSED_ERROR } : {}),
            },
            now,
          );
          if (merged) logActivity(tx, row.itemId, `${row.repo}#${row.number} was merged`, now);
          if (closed) logActivity(tx, row.itemId, `${row.repo}#${row.number} was closed on GitHub without merging`, now);
          count++;
        }
        return count;
      });
    } catch (err) {
      failed += chunk.length;
      firstError ??= errorMessage(err);
      if (err instanceof TransientError && err.retryAfterMs) retryAfterMs = Math.max(retryAfterMs, err.retryAfterMs);
    }
  }

  if (firstError === null) {
    recordPollSuccess(deps.db, 'github', null, now);
  } else {
    // The runner waits one interval after the last error; a longer Retry-After pushes that moment into the future.
    const extra = Math.max(0, retryAfterMs - (deps.intervalMs ?? 0));
    recordPollError(deps.db, 'github', `${firstError} (${failed} PR(s) skipped)`, now + extra);
  }
  return { updated, failed };
}
