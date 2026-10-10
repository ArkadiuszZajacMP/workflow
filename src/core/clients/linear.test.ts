import { describe, expect, it, vi } from 'vitest';
import { PermanentError, TransientError } from '@/core/errors';
import { createLinearClient } from './linear';

function fakeFetch(...responses: { status?: number; body?: unknown; headers?: Record<string, string> }[]) {
  const fn = vi.fn(async () => {
    const r = responses.shift() ?? { body: { data: {} } };
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: r.headers });
  });
  return fn;
}
const bodyOf = (fn: ReturnType<typeof fakeFetch>, call = 0) =>
  JSON.parse((fn.mock.calls[call] as unknown as [string, RequestInit])[1].body as string);

describe('createLinearClient', () => {
  it('fetches only open issues on the first poll and uses gte afterwards', async () => {
    const page = { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } };
    const fetchFn = fakeFetch({ body: { data: page } }, { body: { data: page } });
    const client = createLinearClient('key', fetchFn as unknown as typeof fetch);

    await client.listMyIssuesUpdatedSince(null);
    expect(bodyOf(fetchFn, 0).variables.filter).toMatchObject({ state: { type: { nin: ['completed', 'canceled'] } } });

    await client.listMyIssuesUpdatedSince('2026-10-10T00:00:00.000Z', 'cursor-1');
    expect(bodyOf(fetchFn, 1).variables).toMatchObject({
      after: 'cursor-1',
      filter: { updatedAt: { gte: '2026-10-10T00:00:00.000Z' } },
    });
  });

  it('maps issue nodes', async () => {
    const node = {
      id: 'i1', identifier: 'ENG-1', title: 'Bug', url: 'u', updatedAt: 't',
      state: { name: 'Triage' }, labels: { nodes: [{ name: 'bug' }] },
    };
    const fetchFn = fakeFetch({ body: { data: { issues: { nodes: [node], pageInfo: { hasNextPage: true, endCursor: 'c2' } } } } });
    const result = await createLinearClient('key', fetchFn as unknown as typeof fetch).listMyIssuesUpdatedSince(null);
    expect(result).toEqual({
      issues: [{ id: 'i1', identifier: 'ENG-1', title: 'Bug', url: 'u', updatedAt: 't', status: 'Triage', labels: ['bug'] }],
      endCursor: 'c2',
      hasNextPage: true,
    });
  });

  it('maps search results with closedAt from completedAt or canceledAt', async () => {
    const nodes = [
      { id: 'a', identifier: 'ENG-1', title: 'A', url: 'u', description: null, completedAt: null, canceledAt: '2026-01-01', state: { name: 'Canceled' } },
    ];
    const fetchFn = fakeFetch({ body: { data: { searchIssues: { nodes } } } });
    const results = await createLinearClient('key', fetchFn as unknown as typeof fetch).searchIssues('export', 'ENG', 15);
    expect(results).toEqual([{ id: 'a', identifier: 'ENG-1', title: 'A', url: 'u', description: '', status: 'Canceled', closedAt: '2026-01-01' }]);
    expect(bodyOf(fetchFn).variables).toMatchObject({ term: 'export', first: 15, filter: { team: { key: { eq: 'ENG' } } } });
  });

  it('turns 429 into TransientError with Retry-After', async () => {
    const fetchFn = fakeFetch({ status: 429, headers: { 'retry-after': '20' } });
    const err = await createLinearClient('key', fetchFn as unknown as typeof fetch).viewer().catch((e) => e);
    expect(err).toBeInstanceOf(TransientError);
    expect(err.retryAfterMs).toBe(20_000);
  });

  it('turns GraphQL errors into PermanentError, except rate limits', async () => {
    const fetchFn = fakeFetch(
      { status: 400, body: { errors: [{ message: 'Argument Validation Error' }] } },
      { status: 400, body: { errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATELIMITED' } }] } },
    );
    const client = createLinearClient('key', fetchFn as unknown as typeof fetch);
    await expect(client.viewer()).rejects.toBeInstanceOf(PermanentError);
    await expect(client.viewer()).rejects.toBeInstanceOf(TransientError);
  });

  it('returns null from getIssue when the issue does not exist', async () => {
    const fetchFn = fakeFetch({ status: 400, body: { errors: [{ message: 'Entity not found: Issue' }] } });
    await expect(createLinearClient('key', fetchFn as unknown as typeof fetch).getIssue('ENG-404')).resolves.toBeNull();
  });

  it('throws when the default team does not exist', async () => {
    const fetchFn = fakeFetch({ body: { data: { teams: { nodes: [] } } } });
    await expect(createLinearClient('key', fetchFn as unknown as typeof fetch).getTeamId('NOPE')).rejects.toThrow(
      'Linear team "NOPE" not found',
    );
  });
});
