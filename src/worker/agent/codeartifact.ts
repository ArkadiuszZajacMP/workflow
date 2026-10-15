import { PermanentError } from '@/core/errors';
import type { RepoDefaults } from '@/core/repos/map';
import type { Runner } from './process';

const REFRESH_MARGIN_MS = 30 * 60_000;

/** Short-lived CodeArtifact npm tokens, fetched with the host AWS CLI and cached in memory. */
export class CodeArtifactTokens {
  private cache = new Map<string, { token: string; expiresAt: number }>();

  constructor(
    private readonly run: Runner,
    private readonly now: () => number = Date.now,
  ) {}

  async token(profile: string, defaults: RepoDefaults): Promise<string> {
    const cached = this.cache.get(profile);
    if (cached && cached.expiresAt - REFRESH_MARGIN_MS > this.now()) return cached.token;
    const result = await this.run(
      'aws',
      [
        'codeartifact',
        'get-authorization-token',
        '--domain',
        defaults.codeArtifactDomain,
        '--domain-owner',
        defaults.awsAccountId,
        '--region',
        defaults.awsRegion,
        '--profile',
        profile,
        '--output',
        'json',
      ],
      { timeoutMs: 60_000 },
    );
    if (result.exitCode !== 0) {
      throw new PermanentError(
        `AWS CodeArtifact token for profile ${profile} failed: ${(result.stderr || result.stdout).trim()}. Try: aws sso login --profile ${profile}`,
      );
    }
    const parsed = JSON.parse(result.stdout) as { authorizationToken: string; expiration: string | number };
    const expiresAt = typeof parsed.expiration === 'number' ? parsed.expiration * 1000 : Date.parse(parsed.expiration);
    this.cache.set(profile, {
      token: parsed.authorizationToken,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : this.now() + 60 * 60_000,
    });
    return parsed.authorizationToken;
  }
}

export function registryAuthKey(registry: string): string {
  const url = new URL(registry);
  return `//${url.host}${url.pathname}`;
}

/**
 * Wraps a container command so it runs with ~/.npmrc and ~/.yarnrc.yml carrying
 * $CODEARTIFACT_AUTH_TOKEN (passed via `--env`), and removes both files when it exits.
 */
export function withRegistryAuth(args: string[], registry: string): string[] {
  const key = registryAuthKey(registry);
  const script = [
    `printf '%s:_authToken=%s\\n' '${key}' "$CODEARTIFACT_AUTH_TOKEN" > "$HOME/.npmrc"`,
    `printf 'npmRegistries:\\n  "%s":\\n    npmAuthToken: "%s"\\n    npmAlwaysAuth: true\\n' '${registry}' "$CODEARTIFACT_AUTH_TOKEN" > "$HOME/.yarnrc.yml"`,
    `trap 'rm -f "$HOME/.npmrc" "$HOME/.yarnrc.yml"' EXIT`,
    '"$@"',
  ].join('\n');
  return ['sh', '-c', script, 'sh', ...args];
}
