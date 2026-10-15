import { describe, expect, it, vi } from 'vitest';
import { PermanentError, TransientError } from '@/core/errors';
import { createGitHubClient, mapCiState, prKey } from './github';

type Reply = { status?: number; body?: unknown; text?: string; headers?: Record<string, string> };
function fakeFetch(...replies: Reply[]) {
  return vi.fn(async (_url: string, _init?: RequestInit) => {
    const r = replies.shift() ?? { body: {} };
    const payload = r.text ?? JSON.stringify(r.body ?? {});
    return new Response(payload, { status: r.status ?? 200, headers: r.headers });
  });
}
const client = (f: ReturnType<typeof fakeFetch>) => createGitHubClient('gh-token', f as unknown as typeof fetch);
const gqlBody = (f: ReturnType<typeof fakeFetch>, call = 0) => JSON.parse((f.mock.calls[call]![1] as RequestInit).body as string);

const prNode = { number: 12, url: 'https://github.com/acme/core/pull/12', state: 'OPEN', isDraft: true, merged: false, headRefName: 'boo-1-x', headRefOid: 'abc' };

describe('createGitHubClient', () => {
  it('sends the token and reads the viewer', async () => {
    const f = fakeFetch({ body: { data: { viewer: { login: 'arek' } } } });
    await expect(client(f).viewer()).resolves.toEqual({ login: 'arek' });
    expect((f.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer gh-token' });
  });

  it('maps a pull request and returns null when missing', async () => {
    const f = fakeFetch(
      { body: { data: { repository: { pullRequest: prNode } } } },
      { body: { data: { repository: { pullRequest: null } } } },
    );
    await expect(client(f).getPullRequest('acme/core', 12)).resolves.toEqual({
      number: 12,
      url: 'https://github.com/acme/core/pull/12',
      state: 'OPEN',
      isDraft: true,
      merged: false,
      headRefName: 'boo-1-x',
      headSha: 'abc',
    });
    expect(gqlBody(f).variables).toEqual({ owner: 'acme', name: 'core', number: 12 });
    await expect(client(f).getPullRequest('acme/core', 99)).resolves.toBeNull();
  });

  it('finds an open PR by branch', async () => {
    const f = fakeFetch({ body: { data: { repository: { pullRequests: { nodes: [prNode] } } } } }, { body: { data: { repository: { pullRequests: { nodes: [] } } } } });
    await expect(client(f).findOpenPrForBranch('acme/core', 'boo-1-x')).resolves.toMatchObject({ number: 12 });
    await expect(client(f).findOpenPrForBranch('acme/core', 'nope')).resolves.toBeNull();
  });

  it('batches PR statuses with aliases and counts unresolved threads', async () => {
    const node = (draft: boolean, rollup: string | null, resolved: boolean[]) => ({
      pullRequest: {
        isDraft: draft,
        merged: false,
        state: 'OPEN',
        reviewThreads: { nodes: resolved.map((isResolved) => ({ isResolved })) },
        commits: { nodes: [{ commit: { statusCheckRollup: rollup ? { state: rollup } : null } }] },
      },
    });
    const f = fakeFetch({ body: { data: { p0: node(true, 'SUCCESS', [true, false]), p1: node(false, null, []) } } });
    const result = await client(f).prStatuses([
      { repo: 'acme/core', number: 12 },
      { repo: 'acme/web', number: 3 },
    ]);
    expect(result.get(prKey('acme/core', 12))).toEqual({ isDraft: true, merged: false, state: 'OPEN', unresolvedThreads: 1, ciState: 'success' });
    expect(result.get(prKey('acme/web', 3))).toMatchObject({ ciState: 'none', unresolvedThreads: 0 });
    expect(gqlBody(f).query).toContain('p0: repository(owner: "acme", name: "core")');
  });

  it('returns only unresolved threads with their comments', async () => {
    const f = fakeFetch({
      body: {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  { id: 'T1', isResolved: false, path: 'src/a.ts', line: 4, comments: { nodes: [{ author: { login: 'coderabbitai' }, body: 'Handle null' }] } },
                  { id: 'T2', isResolved: true, path: 'src/b.ts', line: 1, comments: { nodes: [] } },
                ],
              },
            },
          },
        },
      },
    });
    await expect(client(f).unresolvedThreads('acme/core', 12)).resolves.toEqual([
      { id: 'T1', path: 'src/a.ts', line: 4, comments: [{ author: 'coderabbitai', body: 'Handle null' }] },
    ]);
  });

  it('collects failing checks with an Actions log tail', async () => {
    const log = Array.from({ length: 250 }, (_, i) => `line ${i}`).join('\n');
    const f = fakeFetch(
      { body: { data: { repository: { pullRequest: prNode } } } },
      {
        body: {
          check_runs: [
            { id: 7, name: 'lint', conclusion: 'failure', app: { slug: 'github-actions' }, output: { title: 'Lint failed', summary: '2 errors' } },
            { id: 8, name: 'build', conclusion: 'success', app: { slug: 'github-actions' }, output: {} },
          ],
        },
      },
      { text: log },
    );
    const checks = await client(f).failingChecks('acme/core', 12);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ name: 'lint', summary: 'Lint failed — 2 errors' });
    expect(checks[0]!.logTail.split('\n')).toHaveLength(200);
    expect(f.mock.calls[1]![0]).toBe('https://api.github.com/repos/acme/core/commits/abc/check-runs?per_page=100');
    expect(f.mock.calls[2]![0]).toBe('https://api.github.com/repos/acme/core/actions/jobs/7/logs');
  });

  it('classifies errors', async () => {
    await expect(client(fakeFetch({ status: 401, body: { message: 'Bad credentials' } })).viewer()).rejects.toBeInstanceOf(PermanentError);
    await expect(client(fakeFetch({ status: 502 })).viewer()).rejects.toBeInstanceOf(TransientError);
    const limited = await client(
      fakeFetch({ status: 403, body: { message: 'rate limit' }, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '9999999999' } }),
    )
      .viewer()
      .catch((e) => e);
    expect(limited).toBeInstanceOf(TransientError);
    await expect(client(fakeFetch({ body: { errors: [{ message: 'Field x missing' }] } })).viewer()).rejects.toBeInstanceOf(PermanentError);
  });
});

describe('mapCiState', () => {
  it('maps GitHub rollup states', () => {
    expect(['SUCCESS', 'FAILURE', 'ERROR', 'PENDING', 'EXPECTED', null].map(mapCiState)).toEqual([
      'success',
      'failure',
      'failure',
      'pending',
      'pending',
      'none',
    ]);
  });
});
