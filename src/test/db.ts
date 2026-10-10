import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type Db, openDb } from '@/core/db/client';

export function createTestDb(): Db {
  const dir = mkdtempSync(path.join(tmpdir(), 'workflow-test-'));
  return openDb(path.join(dir, 'test.db'));
}
