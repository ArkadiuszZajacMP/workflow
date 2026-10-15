import { describe, expect, it } from 'vitest';
import type { WorkState } from '@/core/db/schema';
import { type WorkEvent, transitionWork } from './machine';

describe('transitionWork', () => {
  it.each<[WorkState | null, WorkEvent, WorkState]>([
    [null, { type: 'start' }, 'investigating'],
    ['investigating', { type: 'plan_saved' }, 'plan_ready'],
    ['plan_ready', { type: 'user_edited' }, 'plan_ready'],
    ['plan_ready', { type: 'revise_requested' }, 'investigating'],
    ['plan_ready', { type: 'approved' }, 'posting_plan'],
    ['posting_plan', { type: 'plan_posted' }, 'implementing'],
    ['implementing', { type: 'all_prs_open' }, 'prs_open'],
    ['investigating', { type: 'job_failed' }, 'failed'],
    ['posting_plan', { type: 'job_failed' }, 'failed'],
    ['implementing', { type: 'job_failed' }, 'failed'],
    ['failed', { type: 'retry', to: 'implementing' }, 'implementing'],
  ])('%s + %o → %s', (from, event, to) => {
    expect(transitionWork(from, event)).toEqual({ ok: true, state: to });
  });

  it('rejects starting twice and approving while investigating', () => {
    expect(transitionWork('investigating', { type: 'start' }).ok).toBe(false);
    expect(transitionWork('investigating', { type: 'approved' })).toEqual({
      ok: false,
      error: 'Cannot approve the plan while work is investigating',
    });
  });

  it('only retries failed work, and never into failed, prs_open or plan_ready', () => {
    expect(transitionWork('plan_ready', { type: 'retry', to: 'investigating' }).ok).toBe(false);
    expect(transitionWork('failed', { type: 'retry', to: 'failed' }).ok).toBe(false);
    expect(transitionWork('failed', { type: 'retry', to: 'prs_open' }).ok).toBe(false);
  });

  it('does not fail work that is plan_ready or prs_open', () => {
    expect(transitionWork('plan_ready', { type: 'job_failed' }).ok).toBe(false);
    expect(transitionWork('prs_open', { type: 'job_failed' }).ok).toBe(false);
  });
});
