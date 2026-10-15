import { and, asc, eq, ne } from 'drizzle-orm';
import type { Db } from '../db/client';
import { type CiState, type Item, type Plan, type PlannedPr, plannedPrs } from '../db/schema';
import { PermanentError } from '../errors';
import { findRepo, type RepoMap } from '../repos/map';

export type PlannedPrPatch = Partial<
  Pick<
    PlannedPr,
    'state' | 'prNumber' | 'prUrl' | 'branch' | 'isDraft' | 'merged' | 'unresolvedThreads' | 'ciState' | 'polledAt' | 'lastError'
  >
>;

export function branchName(identifier: string, scope: string): string {
  const slug = scope
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `${identifier.toLowerCase()}-${slug || 'change'}`;
}

export function createPlannedPrs(db: Db, item: Item, plan: Plan, map: RepoMap, now = Date.now()): PlannedPr[] {
  const identifier = item.linearIdentifier;
  if (!identifier) throw new PermanentError(`Item #${item.id} has no Linear issue`);
  const used = new Set<string>();
  return plan.breakdown.map((entry, index) => {
    const repo = findRepo(map, entry.repo);
    if (!repo) throw new PermanentError(`Unknown repository "${entry.repo}"`);
    let branch = branchName(identifier, entry.scope);
    if (used.has(branch)) branch = `${branch}-${index + 1}`;
    used.add(branch);
    return db
      .insert(plannedPrs)
      .values({
        itemId: item.id,
        planVersion: plan.version,
        position: index + 1,
        repoKey: repo.key,
        githubRepo: repo.repo,
        scope: entry.scope,
        branch,
        state: 'pending',
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
  });
}

export function listPlannedPrs(db: Db, itemId: number): PlannedPr[] {
  return db.select().from(plannedPrs).where(eq(plannedPrs.itemId, itemId)).orderBy(asc(plannedPrs.position)).all();
}

export function getPlannedPr(db: Db, id: number): PlannedPr | undefined {
  return db.select().from(plannedPrs).where(eq(plannedPrs.id, id)).get();
}

export function updatePlannedPr(db: Db, id: number, patch: PlannedPrPatch, now = Date.now()): PlannedPr {
  return db
    .update(plannedPrs)
    .set({ ...patch, updatedAt: now })
    .where(eq(plannedPrs.id, id))
    .returning()
    .get();
}

export function nextPendingPr(db: Db, itemId: number): PlannedPr | undefined {
  return db
    .select()
    .from(plannedPrs)
    .where(and(eq(plannedPrs.itemId, itemId), eq(plannedPrs.state, 'pending')))
    .orderBy(asc(plannedPrs.position))
    .get();
}

export function allPrsOpen(db: Db, itemId: number): boolean {
  const all = listPlannedPrs(db, itemId);
  return all.length > 0 && all.every((p) => p.state === 'open');
}

/** First planned PR that is not open yet, for resuming implementation. */
export function firstUnfinishedPr(db: Db, itemId: number): PlannedPr | undefined {
  return db
    .select()
    .from(plannedPrs)
    .where(and(eq(plannedPrs.itemId, itemId), ne(plannedPrs.state, 'open')))
    .orderBy(asc(plannedPrs.position))
    .get();
}

export type PrRollup = { planned: number; opened: number; ci: CiState; unresolved: number };

export function prRollup(prs: Pick<PlannedPr, 'state' | 'ciState' | 'unresolvedThreads'>[]): PrRollup {
  const open = prs.filter((p) => p.state === 'open');
  const checked = open.map((p) => p.ciState).filter((c) => c !== 'none');
  const ci: CiState = checked.includes('failure')
    ? 'failure'
    : checked.includes('pending')
      ? 'pending'
      : checked.length > 0
        ? 'success'
        : 'none';
  return {
    planned: prs.length,
    opened: open.length,
    ci,
    unresolved: open.reduce((sum, p) => sum + p.unresolvedThreads, 0),
  };
}
