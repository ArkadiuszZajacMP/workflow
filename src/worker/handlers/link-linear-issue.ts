import { PermanentError } from '@/core/errors';
import { applyTriageEvent, claimLinearIssue, getItem, logActivity } from '@/core/items';
import { jobPayload } from '@/core/jobs/queue';
import type { Handler } from './types';

export const linkLinearIssueHandler: Handler = async (ctx, job) => {
  const { db, linear } = ctx;
  const item = getItem(db, job.itemId);
  if (!item || item.category === 'dismissed') return;
  if (item.triageState !== 'duplicate_suspected' && item.triageState !== 'draft_ready') return;

  const payload = jobPayload(job as typeof job & { type: 'link-linear-issue' });
  const issue = await linear.getIssue(payload.issueId ?? payload.identifier);
  if (!issue) throw new PermanentError(`Linear issue ${payload.identifier} not found`);
  if (item.slackPermalink) await linear.attachUrl(issue.id, item.slackPermalink, 'Slack thread');

  if (getItem(db, item.id)?.category === 'dismissed') return;
  const now = ctx.now();
  db.transaction((tx) => {
    claimLinearIssue(tx, item.id, issue, now);
    applyTriageEvent(tx, item.id, { type: 'issue_linked' }, now);
    logActivity(tx, item.id, `Linked to ${issue.identifier}`, now);
  });
};
