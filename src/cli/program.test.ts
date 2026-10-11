import { describe, expect, it } from 'vitest';
import { saveDraft } from '@/core/drafts';
import { getItem } from '@/core/items';
import { createTestDb } from '@/test/db';
import { seedItem } from '@/test/seed';
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
