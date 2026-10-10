import { describe, expect, it } from 'vitest';
import { createTestDb } from '@/test/db';
import { seedItem } from '@/test/seed';
import { latestDraft, listDrafts, listDuplicateCandidates, renderIssueDescription, replaceDuplicateCandidates, saveDraft } from './drafts';

const content = { title: 'Export fails', problem: 'CSV export returns 500.', acceptanceCriteria: ['Export succeeds', 'Large files work'] };

describe('drafts', () => {
  it('numbers versions per item', () => {
    const db = createTestDb();
    const item = seedItem(db);
    saveDraft(db, item.id, content, 'claude', null, 1);
    const v2 = saveDraft(db, item.id, { ...content, title: 'Edited' }, 'user', null, 2);
    expect(v2.version).toBe(2);
    expect(latestDraft(db, item.id)).toMatchObject({ version: 2, title: 'Edited', author: 'user' });
    expect(listDrafts(db, item.id).map((d) => d.version)).toEqual([1, 2]);
  });

  it('renders only problem and acceptance criteria', () => {
    expect(renderIssueDescription(content)).toBe(
      '## Problem\nCSV export returns 500.\n\n## Acceptance criteria\n- [ ] Export succeeds\n- [ ] Large files work\n',
    );
  });

  it('replaces duplicate candidates', () => {
    const db = createTestDb();
    const item = seedItem(db);
    const issue = { id: 'i1', identifier: 'ENG-1', title: 'Old', url: 'u' };
    replaceDuplicateCandidates(db, item.id, [{ issue, confidence: 0.9, reasoning: 'same error' }]);
    replaceDuplicateCandidates(db, item.id, [{ issue: { ...issue, id: 'i2', identifier: 'ENG-2' }, confidence: 0.8, reasoning: 'r' }]);
    expect(listDuplicateCandidates(db, item.id).map((c) => c.linearIdentifier)).toEqual(['ENG-2']);
  });
});
