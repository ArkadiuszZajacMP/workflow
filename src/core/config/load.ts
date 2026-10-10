import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import { type Config, configSchema } from './schema';

export const DEFAULT_CONFIG_PATH = 'workflow.config.yaml';

export function configPath(): string {
  return process.env.WORKFLOW_CONFIG ?? DEFAULT_CONFIG_PATH;
}

export type ConfigResult = { ok: true; config: Config } | { ok: false; error: string };

export function parseConfig(text: string): ConfigResult {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    return { ok: false, error: `Invalid YAML: ${(err as Error).message}` };
  }
  const result = configSchema.safeParse(raw);
  if (!result.success) return { ok: false, error: `Invalid config: ${z.prettifyError(result.error)}` };
  return { ok: true, config: result.data };
}

export function loadConfigFile(path: string): ConfigResult {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return { ok: false, error: `Cannot read ${path}: ${(err as Error).message}` };
  }
  return parseConfig(text);
}

export class ConfigStore {
  private last: Config | null = null;

  constructor(private readonly path: string) {}

  reload(): { config: Config | null; error: string | null } {
    const result = loadConfigFile(this.path);
    if (result.ok) {
      this.last = result.config;
      return { config: result.config, error: null };
    }
    return { config: this.last, error: result.error };
  }
}
