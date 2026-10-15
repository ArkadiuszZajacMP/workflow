import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { type AgentRun, type AgentRunKind, agentRuns, type RunOutcome } from '../db/schema';

export function startRun(
  db: Db,
  input: { jobId: number; itemId: number; plannedPrId: number | null; kind: AgentRunKind; logPath: string },
  now = Date.now(),
): AgentRun {
  return db
    .insert(agentRuns)
    .values({ ...input, startedAt: now, outcome: 'running' })
    .returning()
    .get();
}

export function finishRun(db: Db, runId: number, outcome: RunOutcome, summary: string | null, now = Date.now()): void {
  db.update(agentRuns).set({ outcome, summary, endedAt: now }).where(eq(agentRuns.id, runId)).run();
}

export function activeRun(db: Db, itemId: number): AgentRun | undefined {
  return db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.itemId, itemId), eq(agentRuns.outcome, 'running')))
    .orderBy(desc(agentRuns.id))
    .get();
}

export function getRun(db: Db, id: number): AgentRun | undefined {
  return db.select().from(agentRuns).where(eq(agentRuns.id, id)).get();
}

export function listRuns(db: Db, itemId: number, limit = 10): AgentRun[] {
  return db.select().from(agentRuns).where(eq(agentRuns.itemId, itemId)).orderBy(desc(agentRuns.id)).limit(limit).all();
}

export function hasSucceededRun(db: Db, jobId: number, kind: AgentRunKind): boolean {
  return !!db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(eq(agentRuns.jobId, jobId), eq(agentRuns.kind, kind), eq(agentRuns.outcome, 'succeeded')))
    .get();
}
