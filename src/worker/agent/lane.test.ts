import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { configSchema } from '@/core/config/schema';
import { jobs } from '@/core/db/schema';
import { enqueueJob } from '@/core/jobs/queue';
import { makeAgentDeps } from '@/test/agent';
import { createTestDb } from '@/test/db';
import { seedItem } from '@/test/seed';
import type { AgentHandler } from './deps';
import { AgentLane } from './lane';

describe('AgentLane', () => {
  it('runs at most maxConcurrent agent jobs and records completion', async () => {
    const db = createTestDb();
    const { deps } = makeAgentDeps(db);
    const a = seedItem(db);
    const b = seedItem(db);
    const first = enqueueJob(db, 'investigate', a.id, {}, 0);
    const second = enqueueJob(db, 'investigate', b.id, {}, 0);
    enqueueJob(db, 'draft', a.id, {}, 0);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler: AgentHandler = async () => {
      await gate;
    };
    const handlers = { investigate: handler, 'implement-pr': handler, 'fix-pr': handler, 'remove-workspace': handler };
    const lane = new AgentLane(() => deps, handlers);

    expect(lane.fill()).toBe(1);
    expect(lane.fill()).toBe(0);
    expect(db.select().from(jobs).where(eq(jobs.id, second.id)).get()?.status).toBe('queued');
    release();
    await lane.drain();
    expect(db.select().from(jobs).where(eq(jobs.id, first.id)).get()?.status).toBe('done');

    deps.config = configSchema.parse({ linear: { defaultTeam: 'ENG' }, agent: { maxConcurrent: 2 } });
    expect(lane.fill()).toBe(1);
    await lane.drain();
    expect(db.select().from(jobs).all().filter((j) => j.type === 'draft')[0]?.status).toBe('queued');
  });

  it('does nothing while agent workers are not configured', () => {
    const lane = new AgentLane(() => null);
    expect(lane.fill()).toBe(0);
  });
});
