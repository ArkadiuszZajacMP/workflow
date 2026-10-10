import type { LinearCandidate } from '@/core/clients/types';
import { replaceDuplicateCandidates } from '@/core/drafts';
import { PermanentError } from '@/core/errors';
import { applyTriageEvent, getItem, logActivity, updateItem } from '@/core/items';
import { enqueueJob } from '@/core/jobs/queue';
import { formatCandidates, formatThread, titleFromText } from '@/core/triage/format';
import { assessSchema, searchTermsSchema } from '@/core/triage/schemas';
import type { Handler } from './types';

const DAY_MS = 86_400_000;

export const triageDraftHandler: Handler = async (ctx, job) => {
  const { db, slack, linear, claude, config } = ctx;
  const item = getItem(db, job.itemId);
  if (!item || item.category === 'dismissed') return;
  if (!item.slackChannel || !item.slackThreadTs) throw new PermanentError(`Item #${item.id} has no Slack thread`);
  if (item.triageState === 'new') applyTriageEvent(db, item.id, { type: 'job_started' }, ctx.now());

  const thread = await slack.getThread(item.slackChannel, item.slackThreadTs);
  const permalink = item.slackPermalink ?? (await slack.getPermalink(item.slackChannel, item.slackThreadTs));
  updateItem(db, item.id, { slackThread: thread, slackPermalink: permalink, title: titleFromText(thread[0]?.text ?? '') }, ctx.now());
  const threadText = formatThread(thread);

  const { queries } = await claude.run('search-terms', { thread: threadText }, searchTermsSchema);
  const candidates = new Map<string, LinearCandidate>();
  const oldestClosed = ctx.now() - config.triage.searchClosedWithinDays * DAY_MS;
  for (const q of queries) {
    for (const c of await linear.searchIssues(q, config.linear.defaultTeam, config.triage.maxCandidates)) {
      if (c.closedAt && Date.parse(c.closedAt) < oldestClosed) continue;
      candidates.set(c.identifier, c);
    }
  }
  const shortlist = [...candidates.values()].slice(0, config.triage.maxCandidates);

  let strong: { candidate: LinearCandidate; confidence: number; reasoning: string }[] = [];
  if (shortlist.length > 0) {
    const { duplicates } = await claude.run(
      'assess-duplicates',
      { thread: threadText, candidates: formatCandidates(shortlist) },
      assessSchema,
    );
    strong = duplicates
      .filter((d) => d.confidence >= config.triage.duplicateThreshold && candidates.has(d.identifier))
      .map((d) => ({ candidate: candidates.get(d.identifier)!, confidence: d.confidence, reasoning: d.reasoning }));
  }

  if (getItem(db, item.id)?.category === 'dismissed') return;
  const now = ctx.now();
  db.transaction((tx) => {
    replaceDuplicateCandidates(
      tx,
      item.id,
      strong.map((s) => ({ issue: s.candidate, confidence: s.confidence, reasoning: s.reasoning })),
    );
    if (strong.length > 0) {
      applyTriageEvent(tx, item.id, { type: 'duplicates_found' }, now);
      logActivity(tx, item.id, `Possible duplicate: ${strong.map((s) => s.candidate.identifier).join(', ')}`, now);
    } else {
      applyTriageEvent(tx, item.id, { type: 'no_duplicates' }, now);
      enqueueJob(tx, 'draft', item.id, {}, now);
      logActivity(tx, item.id, 'No duplicate found, drafting an issue', now);
    }
  });
};
