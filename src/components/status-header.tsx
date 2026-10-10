import Link from 'next/link';
import type { QueueStatus } from '@/core/queries';
import { formatAge } from '@/lib/format';

const SOURCES = ['slack', 'linear', 'config'] as const;

export function StatusHeader({ status, now, showDismissed }: { status: QueueStatus; now: number; showDismissed: boolean }) {
  return (
    <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b px-6 py-3 text-sm">
      <h1 className="text-base font-semibold">workflow</h1>
      {SOURCES.map((source) => {
        const poll = status.polls.find((p) => p.source === source);
        return (
          <span key={source} className={poll?.lastError ? 'text-destructive' : 'text-muted-foreground'} title={poll?.lastError ?? undefined}>
            {source}: {poll?.lastError ? 'error' : poll?.lastSuccessAt ? `ok ${formatAge(poll.lastSuccessAt, now)} ago` : 'never'}
          </span>
        );
      })}
      <span className="text-muted-foreground">{status.queuedJobs} queued</span>
      <span className={status.failedJobs ? 'text-destructive' : 'text-muted-foreground'}>{status.failedJobs} failed</span>
      <Link className="ml-auto underline-offset-4 hover:underline" href={showDismissed ? '/' : '/?dismissed=1'}>
        {showDismissed ? 'Back to board' : 'Show dismissed'}
      </Link>
    </header>
  );
}
