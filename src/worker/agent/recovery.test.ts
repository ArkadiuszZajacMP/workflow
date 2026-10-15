import { describe, expect, it } from 'vitest';
import { claimNextJob, enqueueJob } from '@/core/jobs/queue';
import { getRun, startRun } from '@/core/work/runs';
import { createWorkspaceRow, updateWorkspace } from '@/core/work/workspaces';
import { createTestDb } from '@/test/db';
import { FakeEngine } from '@/test/fake-engine';
import { seedItem } from '@/test/seed';
import { cleanupStaleAgentRuns } from './recovery';

describe('cleanupStaleAgentRuns', () => {
  it('kills stray claude in running agent jobs containers and marks running runs stopped', async () => {
    const db = createTestDb();
    const engine = new FakeEngine();
    const item = seedItem(db, { linearIssueId: 'i1', linearIdentifier: 'BOO-7' });
    const job = enqueueJob(db, 'investigate', item.id, {}, 0);
    claimNextJob(db, 0);
    const run = startRun(db, { jobId: job.id, itemId: item.id, plannedPrId: null, kind: 'investigate', logPath: '/x' }, 0);

    await expect(cleanupStaleAgentRuns(db, engine, 50)).resolves.toEqual({ stopped: 1 });
    expect(getRun(db, run.id)).toMatchObject({ outcome: 'stopped', endedAt: 50 });
    expect(engine.execs).toHaveLength(1);
    expect(engine.execs[0]).toMatchObject({ container: 'wf-boo-7', args: ['pkill', '-TERM', '-f', 'claude'] });
  });

  it('still marks runs stopped when the engine is unavailable or exec fails', async () => {
    const db = createTestDb();
    const item = seedItem(db, { linearIssueId: 'i2', linearIdentifier: 'BOO-8' });
    const job = enqueueJob(db, 'investigate', item.id, {}, 0);
    claimNextJob(db, 0);
    const run = startRun(db, { jobId: job.id, itemId: item.id, plannedPrId: null, kind: 'investigate', logPath: '/x' }, 0);
    const failing = { exec: async () => Promise.reject(new Error('no container')) };
    await expect(cleanupStaleAgentRuns(db, failing, 9)).resolves.toEqual({ stopped: 1 });
    expect(getRun(db, run.id)?.outcome).toBe('stopped');
    await expect(cleanupStaleAgentRuns(db, null, 10)).resolves.toEqual({ stopped: 0 });
  });

  it('kills claude in every workspace that is not removed, even when its job is no longer running', async () => {
    const db = createTestDb();
    const engine = new FakeEngine();
    for (const [n, status] of [[1, 'ready'], [2, 'broken'], [3, 'creating'], [4, 'removed']] as const) {
      const item = seedItem(db, { linearIssueId: `w${n}`, linearIdentifier: `BOO-${n}` });
      createWorkspaceRow(db, { itemId: item.id, container: `wf-boo-${n}`, volume: `wf-boo-${n}`, image: 'img' }, 0);
      updateWorkspace(db, item.id, { status }, 0);
    }
    await cleanupStaleAgentRuns(db, engine, 1);
    expect(engine.execs.map((e) => e.container).sort()).toEqual(['wf-boo-1', 'wf-boo-2', 'wf-boo-3']);
    expect(engine.execs.every((e) => e.args.join(' ') === 'pkill -TERM -f claude' && e.timeoutMs === 10_000)).toBe(true);
  });
});
