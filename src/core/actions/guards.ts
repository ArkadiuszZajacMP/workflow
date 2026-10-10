import type { Db } from '../db/client';
import { ActionError } from '../errors';
import { hasActiveJob } from '../jobs/queue';

export function assertNoActiveJob(db: Db, itemId: number): void {
  if (hasActiveJob(db, itemId)) throw new ActionError(`Item #${itemId} already has a job in progress`);
}
