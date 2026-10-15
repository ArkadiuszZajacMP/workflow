import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { BreakdownEntry } from '../db/schema';
import { errorMessage, PermanentError } from '../errors';

const repoSchema = z.object({
  key: z.string().min(1),
  repo: z.string().min(1),
  url: z.string().min(1),
  defaultBranch: z.string().min(1).default('main'),
  type: z.string().min(1).default('node'),
  node: z.string().optional(),
  packageManager: z.string().optional(),
  installCommand: z.string().default(''),
  awsProfile: z.string().optional(),
  validationCommands: z.array(z.string()).default([]),
  envTargets: z.array(z.object({ document: z.string(), path: z.string() })).default([]),
  aliases: z.array(z.string()).default([]),
});

const mapSchema = z.object({
  defaults: z.object({
    awsRegion: z.string().min(1),
    awsAccountId: z.string().min(1),
    codeArtifactDomain: z.string().min(1),
    codeArtifactRegistry: z.string().min(1),
    awsProfile: z.string().optional(),
  }),
  repositories: z.array(repoSchema),
});

export type RepoEntry = z.infer<typeof repoSchema>;
export type RepoDefaults = z.infer<typeof mapSchema>['defaults'];
export type RepoMap = { defaults: RepoDefaults; repos: RepoEntry[] };

export function parseRepoMap(raw: unknown): RepoMap {
  const result = mapSchema.safeParse(raw);
  if (!result.success) throw new PermanentError(`Invalid repository map: ${z.prettifyError(result.error)}`);
  return { defaults: result.data.defaults, repos: result.data.repositories };
}

/** Reads `<skillDir>/config/repositories.json` from the user's meetingpackage skill. */
export function loadRepoMap(skillDir: string): RepoMap {
  const file = path.join(skillDir, 'config', 'repositories.json');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new PermanentError(`Cannot read repository map ${file}: ${errorMessage(err)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new PermanentError(`Repository map ${file} is not valid JSON: ${errorMessage(err)}`);
  }
  return parseRepoMap(raw);
}

export function findRepo(map: RepoMap, key: string): RepoEntry | undefined {
  return map.repos.find((r) => r.key === key);
}

/** Returns a user-facing error for an unusable breakdown, or null when it is fine. */
export function validateBreakdown(breakdown: BreakdownEntry[], map: RepoMap): string | null {
  if (breakdown.length === 0) return 'The plan needs at least one PR in its breakdown';
  for (const [index, entry] of breakdown.entries()) {
    if (!entry.scope.trim()) return `PR ${index + 1} has no scope`;
    if (!findRepo(map, entry.repo)) {
      return `PR ${index + 1} uses unknown repository "${entry.repo}". Known: ${map.repos.map((r) => r.key).join(', ')}`;
    }
  }
  return null;
}
