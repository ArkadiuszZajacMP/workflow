import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '@/test/db';
import { seedItem } from '@/test/seed';
import { enqueueJob } from '@/core/jobs/queue';
import { items } from './schema';

describe('openDb', () => {
  it('creates all tables and enables WAL', () => {
    const db = createTestDb();
    const tables = db
      .all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%migrations%' ORDER BY name`,
      )
      .map((row) => row.name);
    expect(tables).toEqual([
      'activity',
      'agent_runs',
      'drafts',
      'duplicate_candidates',
      'items',
      'jobs',
      'linear_issue_snapshots',
      'planned_prs',
      'plans',
      'poll_cursors',
      'source_events',
      'workspaces',
    ]);
    expect(db.all<{ journal_mode: string }>(sql`PRAGMA journal_mode`)[0]?.journal_mode).toBe('wal');
  });

  it('allows one item per Slack thread but any number of items without a thread', () => {
    const db = createTestDb();
    seedItem(db, { slackChannel: 'C1', slackThreadTs: '1.0' });
    expect(() => seedItem(db, { slackChannel: 'C1', slackThreadTs: '1.0' })).toThrow(/UNIQUE/);
    seedItem(db);
    seedItem(db);
    expect(db.select().from(items).all()).toHaveLength(3);
  });

  it('round-trips JSON columns', () => {
    const db = createTestDb();
    const item = seedItem(db, { slackThread: [{ ts: '1.0', userName: 'ana', text: 'hi', files: [] }] });
    expect(item.slackThread).toEqual([{ ts: '1.0', userName: 'ana', text: 'hi', files: [] }]);
  });
});

describe('agent worker columns', () => {
  it('defaults work_state to null and stop_requested to false', () => {
    const db = createTestDb();
    const item = seedItem(db);
    expect(item.workState).toBeNull();
    const job = enqueueJob(db, 'draft', item.id, {}, 1);
    expect(job.stopRequested).toBe(false);
  });
});
