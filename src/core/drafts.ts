import { asc, desc, eq } from 'drizzle-orm';
import type { Db } from './db/client';
import { type Draft, type DuplicateCandidate, drafts, duplicateCandidates } from './db/schema';
import type { LinearIssueRef } from './types';
import { writeTransaction } from './db/tx';

export type DraftContent = { title: string; problem: string; acceptanceCriteria: string[] };

export function latestDraft(db: Db, itemId: number): Draft | undefined {
  return db.select().from(drafts).where(eq(drafts.itemId, itemId)).orderBy(desc(drafts.version)).get();
}

export function listDrafts(db: Db, itemId: number): Draft[] {
  return db.select().from(drafts).where(eq(drafts.itemId, itemId)).orderBy(asc(drafts.version)).all();
}

export function saveDraft(
  db: Db,
  itemId: number,
  content: DraftContent,
  author: 'claude' | 'user',
  feedback: string | null,
  now = Date.now(),
): Draft {
  const version = (latestDraft(db, itemId)?.version ?? 0) + 1;
  return db
    .insert(drafts)
    .values({ itemId, version, ...content, author, feedback, createdAt: now })
    .returning()
    .get();
}

export function renderIssueDescription(content: DraftContent): string {
  const criteria = content.acceptanceCriteria.map((c) => `- [ ] ${c.trim()}`).join('\n');
  return `## Problem\n${content.problem.trim()}\n\n## Acceptance criteria\n${criteria}\n`;
}

export type CandidateInput = { issue: LinearIssueRef; confidence: number; reasoning: string };

export function replaceDuplicateCandidates(db: Db, itemId: number, candidates: CandidateInput[]): void {
  writeTransaction(db, (tx) => {
    tx.delete(duplicateCandidates).where(eq(duplicateCandidates.itemId, itemId)).run();
    for (const c of candidates) {
      tx.insert(duplicateCandidates)
        .values({
          itemId,
          linearIssueId: c.issue.id,
          linearIdentifier: c.issue.identifier,
          title: c.issue.title,
          url: c.issue.url,
          confidence: c.confidence,
          reasoning: c.reasoning,
        })
        .run();
    }
  });
}

export function listDuplicateCandidates(db: Db, itemId: number): DuplicateCandidate[] {
  return db
    .select()
    .from(duplicateCandidates)
    .where(eq(duplicateCandidates.itemId, itemId))
    .orderBy(desc(duplicateCandidates.confidence))
    .all();
}
