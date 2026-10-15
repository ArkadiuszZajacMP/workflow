import { describe, expect, it } from 'vitest';
import { createTestDb } from '@/test/db';
import { seedItem } from '@/test/seed';
import { cleanPlanContent, latestPlan, listPlans, renderPlanComment, savePlan } from './plans';

const content = {
  body: 'Root cause: the webhook parser disables the JSON parser.\n\nApproach: scope it to /webhooks.',
  breakdown: [
    { repo: 'core', scope: 'Scope raw-body parser to webhook routes' },
    { repo: 'web', scope: 'Show error banner' },
  ],
};

describe('plans', () => {
  it('versions plans per item', () => {
    const db = createTestDb();
    const item = seedItem(db);
    savePlan(db, item.id, content, 'claude', null, 1);
    const v2 = savePlan(db, item.id, { ...content, body: 'Edited' }, 'user', null, 2);
    expect(v2.version).toBe(2);
    expect(latestPlan(db, item.id)).toMatchObject({ version: 2, author: 'user', body: 'Edited' });
    expect(listPlans(db, item.id).map((p) => p.version)).toEqual([1, 2]);
  });

  it('cleans content by trimming and dropping empty breakdown rows', () => {
    expect(
      cleanPlanContent({ body: '  body  ', breakdown: [{ repo: ' core ', scope: ' a ' }, { repo: '', scope: '' }] }),
    ).toEqual({ body: 'body', breakdown: [{ repo: 'core', scope: 'a' }] });
  });

  it('renders the Linear comment', () => {
    expect(renderPlanComment(content)).toBe(
      '## Implementation plan\n\n' +
        'Root cause: the webhook parser disables the JSON parser.\n\nApproach: scope it to /webhooks.\n\n' +
        '### PR breakdown\n' +
        '1. `core` — Scope raw-body parser to webhook routes\n' +
        '2. `web` — Show error banner\n',
    );
  });
});
