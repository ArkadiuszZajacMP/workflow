import { describe, expect, it } from 'vitest';
import { createTestDb } from '@/test/db';
import { seedItem } from '@/test/seed';
import { createWorkspaceRow, getWorkspace, updateWorkspace, workspaceName } from './workspaces';

describe('workspaces', () => {
  it('names workspaces after the Linear identifier', () => {
    expect(workspaceName('BOO-1430')).toBe('wf-boo-1430');
  });

  it('creates and re-creates the row, resetting repos', () => {
    const db = createTestDb();
    const item = seedItem(db);
    createWorkspaceRow(db, { itemId: item.id, container: 'wf-boo-1', volume: 'wf-boo-1', image: 'img' }, 1);
    updateWorkspace(db, item.id, { status: 'ready', repos: ['core'] }, 2);
    expect(getWorkspace(db, item.id)).toMatchObject({ status: 'ready', repos: ['core'], lastUsedAt: 2 });
    const again = createWorkspaceRow(db, { itemId: item.id, container: 'wf-boo-1', volume: 'wf-boo-1', image: 'img2' }, 3);
    expect(again).toMatchObject({ status: 'creating', repos: [], image: 'img2', createdAt: 1, lastUsedAt: 3 });
  });
});
