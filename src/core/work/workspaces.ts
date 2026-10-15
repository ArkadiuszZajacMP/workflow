import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { type Workspace, workspaces } from '../db/schema';

export function workspaceName(identifier: string): string {
  return `wf-${identifier.toLowerCase()}`;
}

export function getWorkspace(db: Db, itemId: number): Workspace | undefined {
  return db.select().from(workspaces).where(eq(workspaces.itemId, itemId)).get();
}

/** Inserts the row, or resets an existing (e.g. removed) one to `creating` with no repos. */
export function createWorkspaceRow(
  db: Db,
  input: { itemId: number; container: string; volume: string; image: string },
  now = Date.now(),
): Workspace {
  return db
    .insert(workspaces)
    .values({ ...input, status: 'creating', repos: [], createdAt: now, lastUsedAt: now })
    .onConflictDoUpdate({
      target: workspaces.itemId,
      set: { container: input.container, volume: input.volume, image: input.image, status: 'creating', repos: [], lastUsedAt: now },
    })
    .returning()
    .get();
}

export function updateWorkspace(
  db: Db,
  itemId: number,
  patch: Partial<Pick<Workspace, 'status' | 'repos' | 'lastUsedAt'>>,
  now = Date.now(),
): Workspace | undefined {
  return db
    .update(workspaces)
    .set({ lastUsedAt: now, ...patch })
    .where(eq(workspaces.itemId, itemId))
    .returning()
    .get();
}
