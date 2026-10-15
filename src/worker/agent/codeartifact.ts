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
    const parsed = parseAuthorization(result.stdout);
    const expiresAt = typeof parsed.expiration === 'number' ? parsed.expiration * 1000 : Date.parse(parsed.expiration);
    this.cache.set(profile, {
      token: parsed.authorizationToken,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : this.now() + 60 * 60_000,
    });
    return parsed.authorizationToken;
  }
}

const TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]+$/;

/** Validates the `get-authorization-token` JSON before any of it reaches a file. */
function parseAuthorization(stdout: string): { authorizationToken: string; expiration: string | number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new PermanentError('AWS CodeArtifact returned unexpected output (not JSON)');
  }
  const record = (parsed ?? {}) as { authorizationToken?: unknown; expiration?: unknown };
  const token = record.authorizationToken;
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
    throw new PermanentError('AWS CodeArtifact returned unexpected output (authorizationToken missing or malformed)');
  }
  if (typeof record.expiration !== 'string' && typeof record.expiration !== 'number') {
    return { authorizationToken: token, expiration: NaN };
  }
  return { authorizationToken: token, expiration: record.expiration };
}

export function registryAuthKey(registry: string): string {
  const url = new URL(registry);
  return `//${url.host}${url.pathname}`;
}

/**
 * Runs with $1 = npmrc auth key and $2 = registry URL, passed as positional
 * parameters so no value is ever spliced into shell code. $CODEARTIFACT_AUTH_TOKEN
 * comes from `--env`. Both rc files are private and removed when the command exits.
 */
const WITH_AUTH_SCRIPT = [
  'umask 077',
  'key="$1"; registry="$2"; shift 2',
  'printf \'%s:_authToken=%s\\n\' "$key" "$CODEARTIFACT_AUTH_TOKEN" > "$HOME/.npmrc"',
  'printf \'npmRegistries:\\n  "%s":\\n    npmAuthToken: "%s"\\n    npmAlwaysAuth: true\\n\' "$registry" "$CODEARTIFACT_AUTH_TOKEN" > "$HOME/.yarnrc.yml"',
  'trap \'rm -f "$HOME/.npmrc" "$HOME/.yarnrc.yml"\' EXIT',
  '"$@"',
].join('\n');

/** Wraps a container command so it runs with the CodeArtifact npm and yarn auth files in place. */
export function withRegistryAuth(args: string[], registry: string): string[] {
  return ['sh', '-c', WITH_AUTH_SCRIPT, 'sh', registryAuthKey(registry), registry, ...args];
}
