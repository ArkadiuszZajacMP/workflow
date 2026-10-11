import type { Db } from '../db/client';
import type { Draft } from '../db/schema';
import { type DraftContent, saveDraft } from '../drafts';
import { ActionError } from '../errors';
import { applyTriageEvent, logActivity } from '../items';
import { requireActiveItem } from './guards';
import { writeTransaction } from '../db/tx';

export function editDraft(db: Db, itemId: number, content: DraftContent, now = Date.now()): Draft {
  const clean: DraftContent = {
    title: content.title.trim(),
    problem: content.problem.trim(),
    acceptanceCriteria: content.acceptanceCriteria.map((c) => c.trim()).filter(Boolean),
  };
  if (!clean.title) throw new ActionError('Draft title cannot be empty');
  if (!clean.problem) throw new ActionError('Draft problem cannot be empty');
  if (clean.acceptanceCriteria.length === 0) throw new ActionError('Draft needs at least one acceptance criterion');
  return writeTransaction(db, (tx) => {
    requireActiveItem(tx, itemId);
    applyTriageEvent(tx, itemId, { type: 'user_edited' }, now);
    const draft = saveDraft(tx, itemId, clean, 'user', null, now);
    logActivity(tx, itemId, `Draft v${draft.version} edited`, now);
    return draft;
  });
}
