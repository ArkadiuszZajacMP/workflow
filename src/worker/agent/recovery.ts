import { eq } from 'drizzle-orm';
import type { Db } from '@/core/db/client';
import { agentRuns, AGENT_JOB_TYPES, items, jobs } from '@/core/db/schema';
import { writeTransaction } from '@/core/db/tx';
import { workspaceName } from '@/core/work/workspaces';
import type { ContainerEngine } from './engine';

/**
 * Run at worker start, before `recoverRunningJobs`. A crash can leave `claude` running in a container and
 * `agent_runs` rows stuck in `running`. Kills the stray processes (best effort, the container may be gone)
 * and marks the leftover runs stopped.
 */
export async function cleanupStaleAgentRuns(
  db: Db,
  engine: Pick<ContainerEngine, 'exec'> | null,
  now = Date.now(),
): Promise<{ stopped: number }> {
  if (engine) {
    const types = new Set<string>(AGENT_JOB_TYPES);
    const agentContainers = new Set(
      db
        .select({ identifier: items.linearIdentifier, type: jobs.type })
        .from(jobs)
        .innerJoin(items, eq(items.id, jobs.itemId))
        .where(eq(jobs.status, 'running'))
        .all()
        .filter((r): r is { identifier: string; type: typeof r.type } => !!r.identifier && types.has(r.type))
        .map((r) => workspaceName(r.identifier)),
    );
    for (const container of agentContainers) {
      try {
        await engine.exec({ container, args: ['pkill', '-TERM', '-f', 'claude'], timeoutMs: 10_000 });
      } catch {
        // Best effort: the container may not exist.
      }
    }
  }
  return writeTransaction(db, (tx) => ({
    stopped: tx
      .update(agentRuns)
      .set({ outcome: 'stopped', endedAt: now, summary: 'Worker stopped or crashed during this run' })
      .where(eq(agentRuns.outcome, 'running'))
      .returning({ id: agentRuns.id })
      .all().length,
  }));
}
