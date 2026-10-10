import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '@/test/db';
import { seedItem } from '@/test/seed';
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
      'drafts',
      'duplicate_candidates',
      'items',
      'jobs',
      'linear_issue_snapshots',
      'poll_cursors',
      'source_events',
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
