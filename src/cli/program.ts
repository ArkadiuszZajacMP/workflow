import { Command } from 'commander';
import {
  approve,
  approvePlan,
  discard,
  fixPr,
  link,
  move,
  removeWorkspace,
  retry,
  retryWork,
  revise,
  revisePlan,
  startInvestigation,
  stopRun,
} from '@/core/actions';
import type { Db } from '@/core/db/client';
import { CATEGORIES, type Category, type Item } from '@/core/db/schema';
import { ActionError, errorMessage } from '@/core/errors';
import { getItemDetail, listItems } from '@/core/queries';
import { loadCurrentRepoMap } from '@/core/repos/current';
import type { RepoMap } from '@/core/repos/map';
import { getItem } from '@/core/items';
import { listPlannedPrs } from '@/core/work/planned-prs';
import { latestPlan, renderPlanComment } from '@/core/work/plans';

type Io = { out: (s: string) => void; err: (s: string) => void };

export function formatItemLine(item: Item): string {
  return [
    `#${item.id}`,
    item.category,
    item.workState ?? item.triageState ?? '-',
    item.linearIdentifier ?? '-',
    item.title || '(untitled)',
  ].join('\t');
}

function parseId(value: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new ActionError('Item id must be a positive integer');
  return id;
}

function parseCategory(value: string): Category {
  if (!CATEGORIES.includes(value as Category)) throw new ActionError(`Unknown category "${value}"`);
  return value as Category;
}

export function buildProgram(db: Db, io: Io, repoMap: () => RepoMap = loadCurrentRepoMap): Command {
  const program = new Command('queue').description('Inspect and change the workflow queue').exitOverride();

  const run =
    <A extends unknown[]>(fn: (...args: A) => void) =>
    (...args: A) => {
      try {
        fn(...args);
      } catch (err) {
        io.err(`Error: ${errorMessage(err)}`);
        process.exitCode = 1;
      }
    };
  const printItem = (item: Item) => io.out(formatItemLine(item));

  program
    .command('list')
    .option('--category <category>', 'triage | in_progress | verification | done | dismissed')
    .option('--json', 'print JSON')
    .action(
      run((opts: { category?: string; json?: boolean }) => {
        const category = opts.category === undefined ? undefined : parseCategory(opts.category);
        const result = listItems(db, { category });
        if (opts.json) io.out(JSON.stringify(result, null, 2));
        else result.forEach(printItem);
      }),
    );

  program
    .command('show <id>')
    .option('--json', 'print JSON')
    .action(
      run((id: string, opts: { json?: boolean }) => {
        const detail = getItemDetail(db, parseId(id));
        if (!detail) throw new ActionError(`Item #${id} not found`);
        if (opts.json) return io.out(JSON.stringify(detail, null, 2));
        printItem(detail.item);
        const draft = detail.drafts.at(-1);
        if (draft) io.out(`\nDraft v${draft.version} (${draft.author}): ${draft.title}\n${draft.problem}\n${draft.acceptanceCriteria.map((c) => `- [ ] ${c}`).join('\n')}`);
        for (const c of detail.candidates) io.out(`Possible duplicate ${c.linearIdentifier} (${c.confidence}): ${c.reasoning}`);
        if (detail.item.lastError) io.out(`Last error: ${detail.item.lastError}`);
        io.out(`\n${detail.activity.map((a) => `${new Date(a.createdAt).toISOString()}  ${a.message}`).join('\n')}`);
      }),
    );

  program.command('move <id> <category>').action(run((id: string, category: string) => printItem(move(db, parseId(id), category as Category))));
  program.command('approve <id>').action(run((id: string) => printItem(approve(db, parseId(id)))));
  program.command('discard <id>').action(run((id: string) => printItem(discard(db, parseId(id)))));
  program.command('retry <id>').action(
    run((id: string) => {
      const itemId = parseId(id);
      // Failed work (investigation, plan posting, implementation) has its own retry; otherwise retry triage.
      printItem(getItem(db, itemId)?.workState === 'failed' ? retryWork(db, itemId) : retry(db, itemId));
    }),
  );
  program.command('link <id> <identifier>').action(run((id: string, identifier: string) => printItem(link(db, parseId(id), { identifier }))));
  program.command('revise <id> <feedback>').action(run((id: string, feedback: string) => printItem(revise(db, parseId(id), feedback))));

  program.command('investigate <id>').action(run((id: string) => printItem(startInvestigation(db, parseId(id)))));
  program
    .command('plan <id>')
    .option('--json', 'print JSON')
    .action(
      run((id: string, opts: { json?: boolean }) => {
        const plan = latestPlan(db, parseId(id));
        if (!plan) throw new ActionError(`Item #${id} has no plan`);
        if (opts.json) return io.out(JSON.stringify(plan, null, 2));
        io.out(`Plan v${plan.version} (${plan.author})\n\n${renderPlanComment(plan)}`);
      }),
    );
  program.command('approve-plan <id>').action(run((id: string) => printItem(approvePlan(db, parseId(id), repoMap()))));
  program
    .command('revise-plan <id> <feedback>')
    .action(run((id: string, feedback: string) => printItem(revisePlan(db, parseId(id), feedback))));
  program.command('fix-pr <id> <position>').action(
    run((id: string, position: string) => {
      const itemId = parseId(id);
      const pr = listPlannedPrs(db, itemId).find((p) => p.position === Number(position));
      if (!pr) throw new ActionError(`Item #${itemId} has no PR ${position}`);
      printItem(fixPr(db, itemId, pr.id));
    }),
  );
  program.command('stop-run <id>').action(run((id: string) => printItem(stopRun(db, parseId(id)))));
  program
    .command('workspace')
    .description('Manage agent workspaces')
    .command('rm <id>')
    .action(run((id: string) => printItem(removeWorkspace(db, parseId(id)))));

  return program;
}
