import { describe, expect, it } from 'vitest';
import { jobs } from '@/core/db/schema';
import { createTestDb } from '@/test/db';
import { seedItem } from '@/test/seed';
import { enqueueWorkspaceGc } from './gc';
import { createWorkspaceRow, updateWorkspace } from './workspaces';

const DAY = 86_400_000;

describe('enqueueWorkspaceGc', () => {
  it('removes workspaces of items done or dismissed for longer than the retention', () => {
    const db = createTestDb();
    const oldDone = seedItem(db, { category: 'done', updatedAt: 0 });
    const recentDone = seedItem(db, { category: 'done', updatedAt: 9 * DAY });
    const active = seedItem(db, { category: 'in_progress', updatedAt: 0 });
    const removed = seedItem(db, { category: 'dismissed', updatedAt: 0 });
    for (const item of [oldDone, recentDone, active, removed]) {
      createWorkspaceRow(db, { itemId: item.id, container: `wf-${item.id}`, volume: `wf-${item.id}`, image: 'img' }, 0);
    }
    updateWorkspace(db, removed.id, { status: 'removed' }, 0);

    expect(enqueueWorkspaceGc(db, 7, 10 * DAY)).toBe(1);
    expect(db.select().from(jobs).all()).toMatchObject([{ type: 'remove-workspace', itemId: oldDone.id }]);
    expect(enqueueWorkspaceGc(db, 7, 10 * DAY)).toBe(0);
  });
});
