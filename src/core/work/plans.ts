import { asc, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { type BreakdownEntry, type Plan, plans } from '../db/schema';

export type PlanContent = { body: string; breakdown: BreakdownEntry[] };

export function latestPlan(db: Db, itemId: number): Plan | undefined {
  return db.select().from(plans).where(eq(plans.itemId, itemId)).orderBy(desc(plans.version)).get();
}

export function listPlans(db: Db, itemId: number): Plan[] {
  return db.select().from(plans).where(eq(plans.itemId, itemId)).orderBy(asc(plans.version)).all();
}

export function savePlan(
  db: Db,
  itemId: number,
  content: PlanContent,
  author: 'claude' | 'user',
  feedback: string | null,
  now = Date.now(),
): Plan {
  const version = (latestPlan(db, itemId)?.version ?? 0) + 1;
  return db
    .insert(plans)
    .values({ itemId, version, body: content.body, breakdown: content.breakdown, author, feedback, createdAt: now })
    .returning()
    .get();
}

export function cleanPlanContent(content: PlanContent): PlanContent {
  return {
    body: content.body.trim(),
    breakdown: content.breakdown
      .map((e) => ({ repo: e.repo.trim(), scope: e.scope.trim() }))
      .filter((e) => e.repo || e.scope),
  };
}

export function renderPlanComment(content: PlanContent): string {
  const rows = content.breakdown.map((e, i) => `${i + 1}. \`${e.repo}\` — ${e.scope.trim()}`).join('\n');
  return `## Implementation plan\n\n${content.body.trim()}\n\n### PR breakdown\n${rows}\n`;
}
