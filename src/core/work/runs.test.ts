import { describe, expect, it } from 'vitest';
import { enqueueJob } from '@/core/jobs/queue';
import { createTestDb } from '@/test/db';
import { seedItem } from '@/test/seed';
import { activeRun, finishRun, listRuns, startRun } from './runs';

describe('agent runs', () => {
  it('tracks one active run per item and finishes it', () => {
    const db = createTestDb();
    const item = seedItem(db);
    const job = enqueueJob(db, 'investigate', item.id, {}, 1);
    const run = startRun(db, { jobId: job.id, itemId: item.id, plannedPrId: null, kind: 'investigate', logPath: '/tmp/x.jsonl' }, 2);
    expect(activeRun(db, item.id)?.id).toBe(run.id);
    finishRun(db, run.id, 'succeeded', 'Plan with 2 PRs', 3);
    expect(activeRun(db, item.id)).toBeUndefined();
    expect(listRuns(db, item.id)).toMatchObject([{ outcome: 'succeeded', summary: 'Plan with 2 PRs', endedAt: 3 }]);
  });
});
