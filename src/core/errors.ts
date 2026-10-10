/** A failure worth retrying later: network errors, 5xx, rate limits. */
export class TransientError extends Error {
  readonly retryAfterMs?: number;

  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'TransientError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** A failure that will not fix itself: bad input, 4xx, invalid Claude output after the retry. */
export class PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentError';
  }
}

/** A user action that is not allowed in the item's current state. Shown to the user as-is. */
export class ActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActionError';
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
