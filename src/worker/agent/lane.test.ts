import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { configSchema } from '@/core/config/schema';
import { jobs } from '@/core/db/schema';
import { PermanentError, ShutdownStop } from '@/core/errors';
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

  it('keeps two jobs in flight under maxConcurrent 2 and a rejecting handler frees its slot', async () => {
    const db = createTestDb();
    const { deps } = makeAgentDeps(db);
    deps.config = configSchema.parse({ linear: { defaultTeam: 'ENG' }, agent: { maxConcurrent: 2 } });
    const a = enqueueJob(db, 'investigate', seedItem(db).id, {}, 0);
    const b = enqueueJob(db, 'investigate', seedItem(db).id, {}, 0);
    const c = enqueueJob(db, 'investigate', seedItem(db).id, {}, 0);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const handler: AgentHandler = async () => {
      calls++;
      if (calls === 1) throw new PermanentError('nope');
      await gate;
    };
    const lane = new AgentLane(() => deps, { investigate: handler, 'implement-pr': handler, 'fix-pr': handler, 'remove-workspace': handler });
    expect(lane.fill()).toBe(2);
    expect(lane.size).toBe(2);
    await new Promise((r) => setTimeout(r, 0));
    const status = (id: number) => db.select().from(jobs).where(eq(jobs.id, id)).get()?.status;
    expect(status(a.id)).toBe('failed');
    expect(lane.size).toBe(1);
    expect(status(b.id)).toBe('running');
    expect(lane.fill()).toBe(1);
    expect(status(c.id)).toBe('running');
    release();
    await lane.drain();
    expect(lane.size).toBe(0);
  });

  it('shutdown stops claiming and requeues interrupted jobs without consuming an attempt', async () => {
    const db = createTestDb();
    const { deps } = makeAgentDeps(db);
    const first = enqueueJob(db, 'investigate', seedItem(db).id, {}, 0);
    const second = enqueueJob(db, 'investigate', seedItem(db).id, {}, 0);
    const handler: AgentHandler = (d) =>
      new Promise((_resolve, reject) => {
        d.shutdownSignal!.addEventListener('abort', () => reject(new ShutdownStop()));
      });
    const lane = new AgentLane(() => deps, { investigate: handler, 'implement-pr': handler, 'fix-pr': handler, 'remove-workspace': handler });
    lane.fill();
    expect(db.select().from(jobs).where(eq(jobs.id, first.id)).get()?.attempts).toBe(1);
    await expect(lane.shutdown(2000)).resolves.toEqual({ timedOut: false });
    expect(lane.size).toBe(0);
    expect(db.select().from(jobs).where(eq(jobs.id, first.id)).get()).toMatchObject({ status: 'queued', attempts: 0, lastError: null });
    expect(lane.fill()).toBe(0);
    expect(db.select().from(jobs).where(eq(jobs.id, second.id)).get()?.status).toBe('queued');
  });

  it('shutdown reports a timeout when runs ignore the stop request', async () => {
    const db = createTestDb();
    const { deps } = makeAgentDeps(db);
    enqueueJob(db, 'investigate', seedItem(db).id, {}, 0);
    const handler: AgentHandler = () => new Promise(() => undefined);
    const lane = new AgentLane(() => deps, { investigate: handler, 'implement-pr': handler, 'fix-pr': handler, 'remove-workspace': handler });
    lane.fill();
    await expect(lane.shutdown(20)).resolves.toEqual({ timedOut: true });
  });

  it('abort stops claiming and aborts in-flight runs right away, before shutdown drains them', async () => {
    const db = createTestDb();
    const { deps } = makeAgentDeps(db);
    const first = enqueueJob(db, 'investigate', seedItem(db).id, {}, 0);
    enqueueJob(db, 'investigate', seedItem(db).id, {}, 0);
    let aborted = false;
    const handler: AgentHandler = (d) =>
      new Promise((_resolve, reject) => {
        d.shutdownSignal!.addEventListener('abort', () => {
          aborted = true;
          reject(new ShutdownStop());
        });
      });
    const lane = new AgentLane(() => ({ ...deps, config: { ...deps.config, agent: { ...deps.config.agent, maxConcurrent: 1 } } }), {
      investigate: handler,
      'implement-pr': handler,
      'fix-pr': handler,
      'remove-workspace': handler,
    });
    expect(lane.fill()).toBe(1);
    lane.abort();
    lane.abort();
    expect(aborted).toBe(true);
    expect(lane.fill()).toBe(0);
    await expect(lane.shutdown(2000)).resolves.toEqual({ timedOut: false });
    expect(db.select().from(jobs).where(eq(jobs.id, first.id)).get()?.status).toBe('queued');
  });
});
