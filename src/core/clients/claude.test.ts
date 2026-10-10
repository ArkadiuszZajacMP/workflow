import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PermanentError } from '@/core/errors';
import { draftSchema, searchTermsSchema } from '@/core/triage/schemas';
import { createClaudeClient, extractJson, renderPrompt } from './claude';

function promptsDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'prompts-'));
  writeFileSync(path.join(dir, 'search-terms.md'), 'Thread:\n{{thread}}');
  return dir;
}

describe('renderPrompt', () => {
  it('fills variables and fails on missing ones', () => {
    expect(renderPrompt('a {{x}} b {{x}}', { x: '1' })).toBe('a 1 b 1');
    expect(() => renderPrompt('{{missing}}', {})).toThrow('Missing prompt variable: missing');
  });
});

describe('extractJson', () => {
  it('accepts bare JSON, fenced JSON and JSON with surrounding prose', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Here you go:\n{"a":{"b":2}}\nThanks')).toEqual({ a: { b: 2 } });
    expect(() => extractJson('no json here')).toThrow();
  });

  it('keeps code fences that sit inside JSON string values', () => {
    // JSON escapes the newlines (\n) inside the string value, as a model would.
    const problem = 'see:\n```\nError: boom\n```';
    expect(extractJson('{"problem":"see:\\n```\\nError: boom\\n```"}')).toEqual({ problem });
    expect(extractJson('```json\n{"problem":"see:\\n```\\nError: boom\\n```"}\n```')).toEqual({ problem });
  });
});

describe('createClaudeClient', () => {
  it('renders the prompt file and validates the output', async () => {
    const complete = vi.fn(async () => '{"queries":["csv export 500"]}');
    const client = createClaudeClient({ complete, promptsDir: promptsDir() });
    await expect(client.run('search-terms', { thread: 'hello' }, searchTermsSchema)).resolves.toEqual({
      queries: ['csv export 500'],
    });
    expect(complete).toHaveBeenCalledWith('Thread:\nhello');
  });

  it('retries once with the validation error, then succeeds', async () => {
    const complete = vi.fn().mockResolvedValueOnce('{"queries":[]}').mockResolvedValueOnce('{"queries":["x"]}');
    const client = createClaudeClient({ complete, promptsDir: promptsDir() });
    await expect(client.run('search-terms', { thread: 't' }, searchTermsSchema)).resolves.toEqual({ queries: ['x'] });
    expect(complete.mock.calls[1]?.[0]).toContain('Your previous reply could not be used');
  });

  it('fails permanently after two invalid replies', async () => {
    const complete = vi.fn(async () => 'not json');
    const client = createClaudeClient({ complete, promptsDir: promptsDir() });
    const err = await client.run('search-terms', { thread: 't' }, searchTermsSchema).catch((e) => e);
    expect(err).toBeInstanceOf(PermanentError);
    expect(err.message).toMatch(/invalid output for search-terms/);
    expect(complete).toHaveBeenCalledTimes(2);
  });
});

describe('the committed prompts', () => {
  it('render with the variables the handlers pass', async () => {
    const complete = vi.fn(async (_prompt: string) => '{"title":"t","problem":"p","acceptanceCriteria":["a"]}');
    const client = createClaudeClient({ complete });
    await client.run('draft', { thread: 'T', previousDraft: '(none)', feedback: '(none)' }, draftSchema);
    expect(complete.mock.calls[0]?.[0]).toContain('T');
  });
});
