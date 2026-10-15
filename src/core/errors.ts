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

/** The worker is shutting down and aborted this run. The job goes back to the queue without consuming an attempt. */
export class ShutdownStop extends Error {
  constructor(message = 'Run stopped by worker shutdown') {
    super(message);
    this.name = 'ShutdownStop';
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

/** SQLite gave up waiting for the write lock (busy_timeout ran out). Trying again later usually works. */
export function isDatabaseBusy(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  return typeof code === 'string' && code.startsWith('SQLITE_BUSY');
}

/** The message to show a user for an expected failure, or null for a bug that should propagate. */
export function userErrorMessage(err: unknown): string | null {
  if (err instanceof ActionError) return err.message;
  if (isDatabaseBusy(err)) return 'Database busy, try again';
  return null;
}
