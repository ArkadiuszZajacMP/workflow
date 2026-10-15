import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigStore, parseConfig } from './load';

const minimal = 'linear:\n  defaultTeam: ENG\n';

describe('parseConfig', () => {
  it('applies defaults to a minimal config', () => {
    expect(parseConfig(minimal)).toEqual({
      ok: true,
      config: {
        linear: { defaultTeam: 'ENG' },
        slack: { pollIntervalSeconds: 60, backfillOnFirstRun: false },
        claude: { model: null },
        triage: { duplicateThreshold: 0.7, searchClosedWithinDays: 90, maxCandidates: 15 },
        agent: {
          containerEngine: 'podman',
          image: 'workflow-agent:latest',
          maxConcurrent: 1,
          timeoutMinutes: { investigate: 20, implement: 60 },
          maxTurns: { investigate: 60, implement: 200 },
          prPollSeconds: 120,
          workspaceRetentionDays: 7,
          meetingpackageSkillDir: '~/.claude/skills/meetingpackage',
          dockerSkillDir: '~/.claude/skills/docker',
          githubSkillDir: '~/.claude/skills/github',
          syncEnv: true,
          envName: 'development',
          defaultRepos: [],
          linearStatusOnImplement: null,
        },
        rules: [],
      },
    });
  });

  it('allows start-investigation on linear rules only', () => {
    const ok = `${minimal}rules:\n  - when: { source: linear, label: ready-to-investigate }\n    category: triage\n    action: start-investigation\n`;
    expect(parseConfig(ok).ok).toBe(true);
    const bad = `${minimal}rules:\n  - when: { source: slack, reaction: eyes }\n    category: triage\n    action: start-investigation\n`;
    expect(parseConfig(bad)).toMatchObject({ ok: false, error: expect.stringContaining('only allowed on linear rules') });
  });

  it('rejects an unknown container engine setting type', () => {
    expect(parseConfig(`${minimal}agent:\n  maxConcurrent: 0\n`).ok).toBe(false);
  });

  it('parses the committed workflow.config.yaml', () => {
    const result = parseConfig(readFileSync('workflow.config.yaml', 'utf8'));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.rules).toHaveLength(4);
  });

  it('rejects a rule with two matchers', () => {
    const text = `${minimal}rules:\n  - when: { source: slack, reaction: eyes, status: Triage }\n    category: triage\n`;
    expect(parseConfig(text).ok).toBe(false);
  });

  it('rejects triage-draft on a linear rule', () => {
    const text = `${minimal}rules:\n  - when: { source: linear, status: Triage }\n    category: triage\n    action: triage-draft\n`;
    expect(parseConfig(text)).toMatchObject({
      ok: false,
      error: expect.stringContaining('only allowed on slack rules'),
    });
  });

  it('rejects an unknown category', () => {
    const text = `${minimal}rules:\n  - when: { source: slack, reaction: eyes }\n    category: dismissed\n`;
    expect(parseConfig(text).ok).toBe(false);
  });

  it('rejects invalid YAML', () => {
    expect(parseConfig('linear: [')).toMatchObject({ ok: false, error: expect.stringContaining('Invalid YAML') });
  });

  it('rejects a config without a default team', () => {
    expect(parseConfig('slack: {}\n').ok).toBe(false);
  });
});

describe('ConfigStore', () => {
  it('keeps the last valid config when the file becomes invalid', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'cfg-')), 'workflow.config.yaml');
    writeFileSync(file, minimal);
    const store = new ConfigStore(file);
    expect(store.reload()).toMatchObject({ error: null, config: { linear: { defaultTeam: 'ENG' } } });

    writeFileSync(file, 'linear: [');
    const second = store.reload();
    expect(second.config?.linear.defaultTeam).toBe('ENG');
    expect(second.error).toMatch(/Invalid YAML/);
  });

  it('reports a missing file with no previous config', () => {
    const store = new ConfigStore('/nonexistent/workflow.config.yaml');
    expect(store.reload()).toMatchObject({ config: null, error: expect.stringContaining('Cannot read') });
  });
});
