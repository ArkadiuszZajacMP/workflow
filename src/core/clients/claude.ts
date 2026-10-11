import { readFileSync } from 'node:fs';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { z } from 'zod';
import { errorMessage, PermanentError, TransientError } from '../errors';
import type { ClaudeClient } from './types';

export type Complete = (prompt: string) => Promise<string>;

export function renderPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    const value = vars[name];
    if (value === undefined) throw new Error(`Missing prompt variable: ${name}`);
    return value;
  });
}

export function extractJson(text: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch {
    // Not bare JSON. Fall through to the fence and prose handling below.
  }
  const fenced = /^\s*```(?:json)?\s*([\s\S]*)\s*```\s*$/.exec(text);
  if (fenced?.[1] !== undefined) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      // The fence did not wrap plain JSON. Fall through to the prose slice.
    }
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end < start) throw new Error('No JSON object in reply');
  return JSON.parse(text.slice(start, end + 1));
}

function parseOutput<T>(text: string, schema: z.ZodType<T>): { ok: true; value: T } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
  const result = schema.safeParse(raw);
  return result.success ? { ok: true, value: result.data } : { ok: false, error: result.error.message };
}

export function createClaudeClient(opts: { complete: Complete; promptsDir?: string }): ClaudeClient {
  const promptsDir = opts.promptsDir ?? path.join(process.cwd(), 'prompts');
  return {
    async run(name, vars, schema) {
      const prompt = renderPrompt(readFileSync(path.join(promptsDir, `${name}.md`), 'utf8'), vars);
      const first = parseOutput(await opts.complete(prompt), schema);
      if (first.ok) return first.value;
      const retryPrompt = `${prompt}\n\nYour previous reply could not be used: ${first.error}\nReply again with only the JSON object.`;
      const second = parseOutput(await opts.complete(retryPrompt), schema);
      if (second.ok) return second.value;
      throw new PermanentError(`Claude returned invalid output for ${name}: ${second.error}`);
    },
  };
}

export const CLAUDE_TIMEOUT_MS = 180_000;

/** Secrets the Claude subprocess never needs. It runs tool-less, but keep them out of its environment anyway. */
const SECRET_ENV_KEYS = ['SLACK_USER_TOKEN', 'LINEAR_API_KEY'];

function claudeEnv(): Record<string, string | undefined> {
  const env = { ...process.env };
  for (const key of SECRET_ENV_KEYS) delete env[key];
  return env;
}

/** Runs one tool-less Claude Code turn with the user's Claude Code login. */
export function sdkComplete(model: () => string | null, timeoutMs = CLAUDE_TIMEOUT_MS): Complete {
  return async (prompt) => {
    let result: string | undefined;
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), timeoutMs);
    try {
      for await (const message of query({
        prompt,
        options: { model: model() ?? undefined, maxTurns: 1, tools: [], allowedTools: [], settingSources: [], abortController, env: claudeEnv() },
      })) {
        if (message.type !== 'result') continue;
        if (message.subtype !== 'success') throw new TransientError(`Claude run ended with ${message.subtype}`);
        result = message.result;
      }
    } catch (err) {
      if (abortController.signal.aborted) throw new TransientError(`Claude timed out after ${timeoutMs / 1000}s`);
      if (err instanceof TransientError) throw err;
      throw new TransientError(`Claude request failed: ${errorMessage(err)}`);
    } finally {
      clearTimeout(timer);
    }
    if (result === undefined) throw new TransientError('Claude returned no result');
    return result;
  };
}
