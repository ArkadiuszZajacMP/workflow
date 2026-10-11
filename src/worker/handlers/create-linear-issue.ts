import { latestDraft, renderIssueDescription } from '@/core/drafts';
import { PermanentError } from '@/core/errors';
import { applyTriageEvent, claimLinearIssue, getItem, logActivity } from '@/core/items';
import { jobPayload } from '@/core/jobs/queue';
import type { LinearIssueRef } from '@/core/types';
import type { Handler } from './types';

export const createLinearIssueHandler: Handler = async (ctx, job) => {
  const { db, linear, config } = ctx;
  const item = getItem(db, job.itemId);
  if (!item || item.category === 'dismissed' || item.triageState !== 'creating_issue') return;
  const draft = latestDraft(db, item.id);
  if (!draft) throw new PermanentError(`Item #${item.id} has no draft`);
  if (!item.slackPermalink) throw new PermanentError(`Item #${item.id} has no Slack permalink`);
  const { issueUuid } = jobPayload(job as typeof job & { type: 'create-linear-issue' });
  if (!issueUuid) throw new PermanentError(`Job #${job.id} has no issue UUID`);

  // A previous attempt may have created the issue and then failed. Never create twice.
  let issue: LinearIssueRef | null =
    item.linearIssueId && item.linearIdentifier && item.linearUrl
      ? { id: item.linearIssueId, identifier: item.linearIdentifier, title: draft.title, url: item.linearUrl }
      : null;
  let message = issue ? `Created ${issue.identifier} in Linear` : '';
  let alreadyAttached = false;

  if (!issue) {
    issue = await linear.findIssueByAttachmentUrl(item.slackPermalink);
    if (issue) {
      message = `Linked existing ${issue.identifier} (thread already attached)`;
      alreadyAttached = true;
    }
  }
  if (!issue) {
    // A create whose response was lost (timeout) left an issue under our UUID that we never recorded.
    issue = await linear.getIssue(issueUuid);
    if (issue) {
      claimLinearIssue(db, item.id, issue, ctx.now());
      message = `Created ${issue.identifier} in Linear`;
    }
  }
  if (!issue) {
    const teamId = await linear.getTeamId(config.linear.defaultTeam);
    issue = await linear.createIssue({ id: issueUuid, teamId, title: draft.title, description: renderIssueDescription(draft) });
    claimLinearIssue(db, item.id, issue, ctx.now());
    message = `Created ${issue.identifier} in Linear`;
  }
  if (!alreadyAttached) {
    await linear.attachUrl(issue.id, item.slackPermalink, 'Slack thread');
  }

  // Dismissed meanwhile: the issue id is already recorded above, so a retry cannot create a second one.
  if (getItem(db, item.id)?.category === 'dismissed') return;
  const now = ctx.now();
  const linked = issue;
  db.transaction((tx) => {
    claimLinearIssue(tx, item.id, linked, now);
    applyTriageEvent(tx, item.id, { type: 'issue_linked' }, now);
    logActivity(tx, item.id, message, now);
  });
};
