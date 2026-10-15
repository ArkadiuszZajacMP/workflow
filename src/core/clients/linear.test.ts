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

  it('creates the issue with the client-supplied UUID as its id', async () => {
    const issue = { id: 'uuid-1', identifier: 'ENG-3', title: 'T', url: 'u3' };
    const fetchFn = fakeFetch({ body: { data: { issueCreate: { success: true, issue } } } });
    const client = createLinearClient('key', fetchFn as unknown as typeof fetch);
    const input = { id: 'uuid-1', teamId: 'team', title: 'T', description: 'body' };
    expect(await client.createIssue(input)).toEqual(issue);
    expect(bodyOf(fetchFn).variables).toEqual({ input });
  });

  it('sends every request with a timeout signal', async () => {
    const fetchFn = fakeFetch({ body: { data: { viewer: { id: 'me', name: 'Me' } } } });
    await createLinearClient('key', fetchFn as unknown as typeof fetch).viewer();
    const init = (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each(['TimeoutError', 'AbortError'])('turns a %s from fetch into TransientError', async (name) => {
    const fetchFn = vi.fn(async () => {
      throw new DOMException('The operation was aborted due to timeout', name);
    });
    const err = await createLinearClient('key', fetchFn as unknown as typeof fetch).viewer().catch((e) => e);
    expect(err).toBeInstanceOf(TransientError);
    expect(err.message).toMatch(/timed out/);
  });

  it('turns a timeout while reading the response body into TransientError', async () => {
    const res = new Response('{}', { status: 200 });
    res.json = async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    };
    const fetchFn = vi.fn(async () => res);
    await expect(createLinearClient('key', fetchFn as unknown as typeof fetch).viewer()).rejects.toBeInstanceOf(TransientError);
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

describe('plan comments and issue details', () => {
  it('reads issue details with description and comments', async () => {
    const fetchFn = fakeFetch({
      body: {
        data: {
          issue: {
            id: 'i1',
            identifier: 'BOO-1',
            title: 'Bug',
            url: 'u',
            description: null,
            comments: { nodes: [{ body: 'first' }, { body: 'second' }] },
          },
        },
      },
    });
    await expect(createLinearClient('key', fetchFn as unknown as typeof fetch).getIssueDetails('BOO-1')).resolves.toEqual({
      id: 'i1',
      identifier: 'BOO-1',
      title: 'Bug',
      url: 'u',
      description: '',
      comments: ['first', 'second'],
    });
  });

  it('checks for a comment by id and treats not-found as false', async () => {
    const fetchFn = fakeFetch(
      { body: { data: { comment: { id: 'c1' } } } },
      { status: 400, body: { errors: [{ message: 'Entity not found: Comment' }] } },
    );
    const client = createLinearClient('key', fetchFn as unknown as typeof fetch);
    await expect(client.commentExists('c1')).resolves.toBe(true);
    await expect(client.commentExists('c2')).resolves.toBe(false);
  });

  it('creates a comment with the client-supplied id', async () => {
    const fetchFn = fakeFetch({ body: { data: { commentCreate: { success: true } } } });
    await createLinearClient('key', fetchFn as unknown as typeof fetch).createComment({ id: 'c1', issueId: 'i1', body: 'plan' });
    expect(bodyOf(fetchFn).variables).toEqual({ input: { id: 'c1', issueId: 'i1', body: 'plan' } });
  });

  it('moves an issue to a workflow state by name, case-insensitively', async () => {
    const fetchFn = fakeFetch(
      { body: { data: { issue: { team: { states: { nodes: [{ id: 's1', name: 'Todo' }, { id: 's2', name: 'In Progress' }] } } } } } },
      { body: { data: { issueUpdate: { success: true } } } },
      { body: { data: { issue: { team: { states: { nodes: [{ id: 's1', name: 'Todo' }] } } } } } },
    );
    const client = createLinearClient('key', fetchFn as unknown as typeof fetch);
    await client.setIssueStateByName('i1', 'in progress');
    expect(bodyOf(fetchFn, 1).variables).toEqual({ id: 'i1', input: { stateId: 's2' } });
    await expect(client.setIssueStateByName('i1', 'Shipped')).rejects.toThrow('Linear state "Shipped" not found');
  });
});
