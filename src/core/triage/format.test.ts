import { describe, expect, it } from 'vitest';
import { formatCandidates, formatDraft, formatThread, titleFromText } from './format';

describe('format helpers', () => {
  it('formats a thread with authors and file names', () => {
    expect(
      formatThread([
        { ts: '1', userName: 'ana', text: 'Export is broken', files: ['error.png'] },
        { ts: '2', userName: 'bo', text: 'Same here', files: [] },
      ]),
    ).toBe('[ana] Export is broken (files: error.png)\n\n[bo] Same here');
  });

  it('formats candidates with status and a trimmed description', () => {
    const text = formatCandidates([
      { id: 'i', identifier: 'ENG-1', title: 'Export 500', url: 'u', status: 'Todo', description: 'x'.repeat(600), closedAt: null },
    ]);
    expect(text.startsWith('ENG-1 [Todo] Export 500\n')).toBe(true);
    expect(text.length).toBeLessThan(560);
  });

  it('formats a missing draft as (none)', () => {
    expect(formatDraft(undefined)).toBe('(none)');
    expect(formatDraft({ title: 'T', problem: 'P', acceptanceCriteria: ['A'] })).toBe(
      'Title: T\n\nProblem:\nP\n\nAcceptance criteria:\n- A',
    );
  });

  it('takes the first non-empty line as title, truncated', () => {
    expect(titleFromText('\n  Export fails for big files  \nmore')).toBe('Export fails for big files');
    expect(titleFromText('a'.repeat(200), 10)).toBe(`${'a'.repeat(9)}…`);
    expect(titleFromText('')).toBe('(no text)');
  });
});
