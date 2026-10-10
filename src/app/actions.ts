'use server';

import { revalidatePath } from 'next/cache';
import * as actions from '@/core/actions';
import { getDb } from '@/core/db/client';
import type { Category } from '@/core/db/schema';
import type { DraftContent } from '@/core/drafts';
import { ActionError } from '@/core/errors';

export type ActionResult = { error?: string };

async function perform(fn: () => unknown): Promise<ActionResult> {
  try {
    fn();
  } catch (err) {
    if (err instanceof ActionError) return { error: err.message };
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
