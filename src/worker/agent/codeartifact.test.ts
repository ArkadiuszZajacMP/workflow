import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PermanentError } from '@/core/errors';
import { TEST_REPO_MAP } from '@/test/repo-map';
import { CodeArtifactTokens, registryAuthKey, withRegistryAuth } from './codeartifact';
import { type ProcessResult, runProcess } from './process';

const ok = (stdout: string): ProcessResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false, aborted: false });

describe('CodeArtifactTokens', () => {
  it('fetches a token on the host with the repo profile and caches it until near expiry', async () => {
    const calls: string[][] = [];
    let now = Date.parse('2026-10-15T10:00:00Z');
    const run = async (_cmd: string, args: string[]) => {
      calls.push(args);
      return ok(JSON.stringify({ authorizationToken: `tok-${calls.length}`, expiration: '2026-10-15T22:00:00Z' }));
    };
    const tokens = new CodeArtifactTokens(run, () => now);
    await expect(tokens.token('core-artifactory', TEST_REPO_MAP.defaults)).resolves.toBe('tok-1');
    await expect(tokens.token('core-artifactory', TEST_REPO_MAP.defaults)).resolves.toBe('tok-1');
    expect(calls[0]).toEqual([
      'codeartifact',
      'get-authorization-token',
      '--domain',
      'acme-npm',
      '--domain-owner',
      '111122223333',
      '--region',
      'eu-west-2',
      '--profile',
      'core-artifactory',
      '--output',
      'json',
    ]);
    now = Date.parse('2026-10-15T21:45:00Z');
    await expect(tokens.token('core-artifactory', TEST_REPO_MAP.defaults)).resolves.toBe('tok-2');
  });

  it('fails permanently when the AWS output is not JSON', async () => {
    const run = async () => ok('not json at all');
    const err = await new CodeArtifactTokens(run).token('core-artifactory', TEST_REPO_MAP.defaults).catch((e) => e);
    expect(err).toBeInstanceOf(PermanentError);
    expect(err.message).toContain('AWS CodeArtifact returned unexpected output');
  });

  it('fails permanently when the token has characters outside the expected set', async () => {
    const run = async () => ok(JSON.stringify({ authorizationToken: 'bad"token', expiration: '2026-10-15T22:00:00Z' }));
    const err = await new CodeArtifactTokens(run).token('core-artifactory', TEST_REPO_MAP.defaults).catch((e) => e);
    expect(err).toBeInstanceOf(PermanentError);
    expect(err.message).toContain('AWS CodeArtifact returned unexpected output');
  });

  it('fails permanently with an aws sso login hint', async () => {
    const run = async () => ({ exitCode: 255, stdout: '', stderr: 'Error when retrieving token from sso: Token has expired', timedOut: false, aborted: false });
    const err = await new CodeArtifactTokens(run).token('core-artifactory', TEST_REPO_MAP.defaults).catch((e) => e);
    expect(err).toBeInstanceOf(PermanentError);
    expect(err.message).toContain('Try: aws sso login --profile core-artifactory');
  });
});

describe('withRegistryAuth', () => {
  it('derives the npmrc auth key from the registry URL', () => {
    expect(registryAuthKey(TEST_REPO_MAP.defaults.codeArtifactRegistry)).toBe(
      '//acme-npm-111122223333.d.codeartifact.eu-west-2.amazonaws.com/npm/acme-internal/',
    );
  });

  it('writes npmrc and yarnrc for the command and removes them afterwards', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ca-home-'));
    const out = path.join(home, 'seen.txt');
    const args = withRegistryAuth(['sh', '-c', `cat "$HOME/.npmrc" "$HOME/.yarnrc.yml" > ${out}`], TEST_REPO_MAP.defaults.codeArtifactRegistry);
    expect(args.join(' ')).not.toContain('secret-token');
    const result = await runProcess(args[0]!, args.slice(1), { env: { HOME: home, CODEARTIFACT_AUTH_TOKEN: 'secret-token' } });
    expect(result.exitCode).toBe(0);
    const seen = readFileSync(out, 'utf8');
    expect(seen).toContain('//acme-npm-111122223333.d.codeartifact.eu-west-2.amazonaws.com/npm/acme-internal/:_authToken=secret-token');
    expect(seen).toContain('npmAuthToken: "secret-token"');
    expect(seen).toContain('npmAlwaysAuth: true');
    expect(existsSync(path.join(home, '.npmrc'))).toBe(false);
    expect(existsSync(path.join(home, '.yarnrc.yml'))).toBe(false);
  });

  it('treats a registry containing a single quote as data, not shell code', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ca-home-'));
    const registry = "https://h.example.com/npm/a'$(touch$IFS.INJECTED)'b/";
    const out = path.join(home, 'seen.txt');
    const args = withRegistryAuth(['sh', '-c', `cat "$HOME/.npmrc" > ${out}`], registry);
    const result = await runProcess(args[0]!, args.slice(1), { cwd: home, env: { HOME: home, CODEARTIFACT_AUTH_TOKEN: 't' } });
    expect(result.exitCode).toBe(0);
    expect(existsSync(path.join(home, '.INJECTED'))).toBe(false);
    expect(readFileSync(out, 'utf8')).toContain(`//h.example.com/npm/a'$(touch$IFS.INJECTED)'b/:_authToken=t`);
  });

  it('removes the token files on exit and on INT, TERM and HUP', () => {
    const script = withRegistryAuth(['true'], TEST_REPO_MAP.defaults.codeArtifactRegistry)[2]!;
    expect(script).toContain('trap \'rm -f "$HOME/.npmrc" "$HOME/.yarnrc.yml"\' EXIT INT TERM HUP');
    expect(script.indexOf('trap')).toBeLessThan(script.indexOf('> "$HOME/.npmrc"'));
  });

  it('propagates the command exit code', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ca-home-'));
    const args = withRegistryAuth(['sh', '-c', 'exit 7'], TEST_REPO_MAP.defaults.codeArtifactRegistry);
    const result = await runProcess(args[0]!, args.slice(1), { env: { HOME: home, CODEARTIFACT_AUTH_TOKEN: 't' } });
    expect(result.exitCode).toBe(7);
    expect(existsSync(path.join(home, '.npmrc'))).toBe(false);
  });
});
