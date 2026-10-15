import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PermanentError } from '@/core/errors';
import { TEST_REPO_MAP } from '@/test/repo-map';
import { findRepo, loadRepoMap, parseRepoMap, validateBreakdown } from './map';

const raw = {
  defaults: TEST_REPO_MAP.defaults,
  staging: { ignored: true },
  repositories: [
    { key: 'core', repo: 'acme/core', url: 'https://github.com/acme/core.git', installCommand: 'yarn install', extra: 1 },
  ],
};

describe('repo map', () => {
  it('parses the skill file shape and fills defaults', () => {
    const map = parseRepoMap(raw);
    expect(map.repos[0]).toMatchObject({
      key: 'core',
      defaultBranch: 'main',
      type: 'node',
      validationCommands: [],
      envTargets: [],
      aliases: [],
    });
    expect(findRepo(map, 'core')?.repo).toBe('acme/core');
    expect(findRepo(map, 'nope')).toBeUndefined();
  });

  it('loads from <skillDir>/config/repositories.json', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mp-skill-'));
    mkdirSync(path.join(dir, 'config'));
    writeFileSync(path.join(dir, 'config', 'repositories.json'), JSON.stringify(raw));
    expect(loadRepoMap(dir).repos).toHaveLength(1);
  });

  it('fails permanently with the path when the file is missing or invalid', () => {
    expect(() => loadRepoMap('/nonexistent/skill')).toThrow(PermanentError);
    expect(() => loadRepoMap('/nonexistent/skill')).toThrow(/\/nonexistent\/skill\/config\/repositories\.json/);
    expect(() => parseRepoMap({ repositories: 'x' })).toThrow(/Invalid repository map/);
  });

  it('includes the file path when the file is schema-invalid', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mp-skill-'));
    mkdirSync(path.join(dir, 'config'));
    const file = path.join(dir, 'config', 'repositories.json');
    writeFileSync(file, '{"repositories":"x"}');
    const err = (() => {
      try {
        loadRepoMap(dir);
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(PermanentError);
    expect((err as Error).message).toContain(file);
    expect((err as Error).message).toContain('Invalid repository map');
  });

  it('includes the file path when the file is not JSON', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mp-skill-'));
    mkdirSync(path.join(dir, 'config'));
    const file = path.join(dir, 'config', 'repositories.json');
    writeFileSync(file, 'not json');
    expect(() => loadRepoMap(dir)).toThrow(PermanentError);
    expect(() => loadRepoMap(dir)).toThrow(file);
    expect(() => loadRepoMap(dir)).toThrow('not valid JSON');
  });

  it('validates a breakdown against the map', () => {
    expect(validateBreakdown([], TEST_REPO_MAP)).toBe('The plan needs at least one PR in its breakdown');
    expect(validateBreakdown([{ repo: 'core', scope: '  ' }], TEST_REPO_MAP)).toBe('PR 1 has no scope');
    expect(validateBreakdown([{ repo: 'core', scope: 'a' }, { repo: 'mobile', scope: 'b' }], TEST_REPO_MAP)).toBe(
      'PR 2 uses unknown repository "mobile". Known: core, web, infra',
    );
    expect(validateBreakdown([{ repo: 'web', scope: 'show field' }], TEST_REPO_MAP)).toBeNull();
  });
});
