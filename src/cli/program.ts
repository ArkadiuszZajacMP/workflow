import { Command } from 'commander';
import { approve, discard, link, move, retry, revise } from '@/core/actions';
import type { Db } from '@/core/db/client';
import { CATEGORIES, type Category, type Item } from '@/core/db/schema';
import { ActionError, errorMessage } from '@/core/errors';
import { getItemDetail, listItems } from '@/core/queries';

type Io = { out: (s: string) => void; err: (s: string) => void };

export function formatItemLine(item: Item): string {
  return [`#${item.id}`, item.category, item.triageState ?? '-', item.linearIdentifier ?? '-', item.title || '(untitled)'].join('\t');
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

export function buildProgram(db: Db, io: Io): Command {
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
  program.command('retry <id>').action(run((id: string) => printItem(retry(db, parseId(id)))));
  program.command('link <id> <identifier>').action(run((id: string, identifier: string) => printItem(link(db, parseId(id), { identifier }))));
  program.command('revise <id> <feedback>').action(run((id: string, feedback: string) => printItem(revise(db, parseId(id), feedback))));

  return program;
}
