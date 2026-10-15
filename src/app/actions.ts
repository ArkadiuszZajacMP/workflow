'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import * as actions from '@/core/actions';
import { getDb } from '@/core/db/client';
import type { Category } from '@/core/db/schema';
import type { DraftContent } from '@/core/drafts';
import type { PlanContent } from '@/core/work/plans';
import { loadCurrentRepoMap } from '@/core/repos/current';
import { userErrorMessage } from '@/core/errors';

export type ActionResult = { error?: string };

async function perform(fn: () => unknown): Promise<ActionResult> {
  try {
    fn();
  } catch (err) {
    const message = userErrorMessage(err);
    if (message !== null) return { error: message };
    throw err;
  }
  revalidatePath('/');
  return {};
}

export async function approveAction(itemId: number) {
  return perform(() => actions.approve(getDb(), itemId));
}
export async function discardAction(itemId: number) {
  return perform(() => actions.discard(getDb(), itemId));
}
export async function moveAction(itemId: number, category: Category) {
  return perform(() => actions.move(getDb(), itemId, category));
}
export async function linkAction(itemId: number, identifier: string, issueId?: string) {
  return perform(() => actions.link(getDb(), itemId, { identifier, issueId }));
}
export async function notDuplicateAction(itemId: number) {
  return perform(() => actions.notDuplicate(getDb(), itemId));
}
export async function reviseAction(itemId: number, feedback: string) {
  return perform(() => actions.revise(getDb(), itemId, feedback));
}
export async function editDraftAction(itemId: number, content: DraftContent) {
  return perform(() => actions.editDraft(getDb(), itemId, content));
}
export async function retryAction(itemId: number) {
  return perform(() => actions.retry(getDb(), itemId));
}

const idSchema = z.number().int().positive();
const planContentSchema = z.object({
  body: z.string().max(100_000),
  breakdown: z.array(z.object({ repo: z.string().max(200), scope: z.string().max(5_000) })).max(50),
});
const feedbackSchema = z.string().trim().min(1).max(20_000);

function invalid(): ActionResult {
  return { error: 'Invalid input' };
}

export async function startInvestigationAction(itemId: number) {
  if (!idSchema.safeParse(itemId).success) return invalid();
  return perform(() => actions.startInvestigation(getDb(), itemId));
}
export async function editPlanAction(itemId: number, content: PlanContent) {
  const parsed = planContentSchema.safeParse(content);
  if (!idSchema.safeParse(itemId).success || !parsed.success) return invalid();
  return perform(() => actions.editPlan(getDb(), itemId, parsed.data, loadCurrentRepoMap()));
}
export async function revisePlanAction(itemId: number, feedback: string) {
  const parsed = feedbackSchema.safeParse(feedback);
  if (!idSchema.safeParse(itemId).success || !parsed.success) return invalid();
  return perform(() => actions.revisePlan(getDb(), itemId, parsed.data));
}
export async function approvePlanAction(itemId: number) {
  if (!idSchema.safeParse(itemId).success) return invalid();
  return perform(() => actions.approvePlan(getDb(), itemId, loadCurrentRepoMap()));
}
export async function retryWorkAction(itemId: number) {
  if (!idSchema.safeParse(itemId).success) return invalid();
  return perform(() => actions.retryWork(getDb(), itemId));
}
export async function fixPrAction(itemId: number, plannedPrId: number) {
  if (!idSchema.safeParse(itemId).success || !idSchema.safeParse(plannedPrId).success) return invalid();
  return perform(() => actions.fixPr(getDb(), itemId, plannedPrId));
}
export async function stopRunAction(itemId: number) {
  if (!idSchema.safeParse(itemId).success) return invalid();
  return perform(() => actions.stopRun(getDb(), itemId));
}
export async function removeWorkspaceAction(itemId: number) {
  if (!idSchema.safeParse(itemId).success) return invalid();
  return perform(() => actions.removeWorkspace(getDb(), itemId));
}
