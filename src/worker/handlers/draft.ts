import { latestDraft, saveDraft } from '@/core/drafts';
import { applyTriageEvent, getItem, logActivity } from '@/core/items';
import { jobPayload } from '@/core/jobs/queue';
import { formatDraft, formatThread } from '@/core/triage/format';
import { draftSchema } from '@/core/triage/schemas';
import type { Handler } from './types';

export const draftHandler: Handler = async (ctx, job) => {
  const { db, claude } = ctx;
  const item = getItem(db, job.itemId);
  if (!item || item.category === 'dismissed' || item.triageState !== 'drafting') return;

  const feedback = jobPayload(job as typeof job & { type: 'draft' }).feedback ?? null;
  const output = await claude.run(
    'draft',
    {
      thread: formatThread(item.slackThread ?? []),
      previousDraft: formatDraft(feedback ? latestDraft(db, item.id) : undefined),
      feedback: feedback ?? '(none)',
    },
    draftSchema,
  );

  if (getItem(db, item.id)?.category === 'dismissed') return;
  const now = ctx.now();
  db.transaction((tx) => {
    const draft = saveDraft(tx, item.id, output, 'claude', feedback, now);
    applyTriageEvent(tx, item.id, { type: 'draft_saved' }, now);
    logActivity(tx, item.id, `Draft v${draft.version} by Claude`, now);
  });
};
