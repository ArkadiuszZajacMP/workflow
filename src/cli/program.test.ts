import { describe, expect, it } from 'vitest';
import { saveDraft } from '@/core/drafts';
import { getItem } from '@/core/items';
import { createTestDb } from '@/test/db';
import { seedItem } from '@/test/seed';
import { TEST_REPO_MAP } from '@/test/repo-map';
import { savePlan } from '@/core/work/plans';
import { jobs } from '@/core/db/schema';
import { updateItem } from '@/core/items';
import { buildProgram, formatItemLine } from './program';

function run(db: ReturnType<typeof createTestDb>, ...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const program = buildProgram(db, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return program.parseAsync(['node', 'queue', ...args]).then(() => ({ out, err }));
}

describe('queue CLI', () => {
  it('formats one line per item', () => {
    const db = createTestDb();
    const item = seedItem(db, { title: 'Export fails', triageState: 'draft_ready', linearIdentifier: 'ENG-4' });
    expect(formatItemLine(item)).toBe(`#${item.id}\ttriage\tdraft_ready\tENG-4\tExport fails`);
  });

  it('lists items as JSON', async () => {
    const db = createTestDb();
    seedItem(db, { title: 'A' });
    const { out } = await run(db, 'list', '--json');
    expect(JSON.parse(out.join(''))).toMatchObject([{ title: 'A' }]);
  });

  it('approves a draft-ready item', async () => {
    const db = createTestDb();
    const item = seedItem(db, { triageState: 'draft_ready' });
    saveDraft(db, item.id, { title: 'T', problem: 'P', acceptanceCriteria: ['A'] }, 'claude', null, 1);
    const { out } = await run(db, 'approve', String(item.id));
    expect(out.join('')).toContain('creating_issue');
    expect(getItem(db, item.id)?.triageState).toBe('creating_issue');
  });

  it('prints invalid transitions as errors and sets a failing exit code', async () => {
    const db = createTestDb();
    const item = seedItem(db, { triageState: 'drafting' });
    const { err } = await run(db, 'approve', String(item.id));
    expect(err.join('')).toMatch(/^Error: Item #\d+ has no draft/);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('rejects an unknown category filter instead of listing everything', async () => {
    const db = createTestDb();
    seedItem(db, { title: 'A' });
    const { out, err } = await run(db, 'list', '--category', 'archived');
    expect(out).toEqual([]);
    expect(err.join('')).toBe('Error: Unknown category "archived"');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('rejects non-numeric ids', async () => {
    const db = createTestDb();
    const { err } = await run(db, 'show', 'abc');
    expect(err.join('')).toContain('Item id must be a positive integer');
    process.exitCode = 0;
  });
});

function runWithMap(db: ReturnType<typeof createTestDb>, ...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const program = buildProgram(db, { out: (s) => out.push(s), err: (s) => err.push(s) }, () => TEST_REPO_MAP);
  return program.parseAsync(['node', 'queue', ...args]).then(() => ({ out, err }));
}

describe('work commands', () => {
  it('starts an investigation and approves a plan', async () => {
    const db = createTestDb();
    const item = seedItem(db, { linearIssueId: 'i1', linearIdentifier: 'BOO-1' });
    await runWithMap(db, 'investigate', String(item.id));
    expect(db.select().from(jobs).all()).toMatchObject([{ type: 'investigate' }]);

    db.delete(jobs).run();
    updateItem(db, item.id, { workState: 'plan_ready' });
    savePlan(db, item.id, { body: 'b', breakdown: [{ repo: 'core', scope: 'x' }] }, 'claude', null, 1);
    const { out } = await runWithMap(db, 'plan', String(item.id));
    expect(out.join('\n')).toContain('1. `core` — x');
    await runWithMap(db, 'approve-plan', String(item.id));
    expect(db.select().from(jobs).all()).toMatchObject([{ type: 'post-plan' }]);
  });

  it('rejects fix-pr for an unknown position', async () => {
    const db = createTestDb();
    const item = seedItem(db, { linearIssueId: 'i1', linearIdentifier: 'BOO-1', workState: 'prs_open' });
    const { err } = await runWithMap(db, 'fix-pr', String(item.id), '3');
    expect(err.join('')).toContain('has no PR 3');
    process.exitCode = 0;
  });
});
