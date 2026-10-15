'use client';

import { fixPrAction } from '@/app/actions';
import { Button } from '@/components/ui/button';
import type { PlannedPr } from '@/core/db/schema';
import { CI_LABELS } from '@/lib/format';
import { useActionRunner } from './use-action-runner';

export function PrsPanel({ itemId, prs, canFix }: { itemId: number; prs: PlannedPr[]; canFix: boolean }) {
  const { pending, error, run } = useActionRunner();
  if (prs.length === 0) return null;
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">Pull requests</h3>
      <ul className="space-y-2">
        {prs.map((pr) => (
          <li key={pr.id} className="space-y-1 rounded-md border p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">{pr.position}.</span>
              <span className="font-mono">{pr.repoKey}</span>
              {pr.prUrl ? (
                <a className="underline-offset-4 hover:underline" href={pr.prUrl} target="_blank" rel="noreferrer">
                  #{pr.prNumber}
                </a>
              ) : (
                <span className="text-muted-foreground">{pr.state}</span>
              )}
              {pr.state === 'open' && (
                <>
                  <span title={CI_LABELS[pr.ciState].label}>{CI_LABELS[pr.ciState].symbol}</span>
                  <span title="Unresolved review threads">💬 {pr.unresolvedThreads}</span>
                  {pr.isDraft && <span className="text-muted-foreground">draft</span>}
                  {pr.merged && <span className="text-muted-foreground">merged</span>}
                </>
              )}
              {canFix && pr.state === 'open' && (
                <Button size="sm" variant="outline" className="ml-auto" disabled={pending} onClick={() => run(() => fixPrAction(itemId, pr.id))}>
                  Fix with Claude
                </Button>
              )}
            </div>
            <p className="text-muted-foreground">{pr.scope}</p>
            {pr.lastError && <p className="text-destructive">{pr.lastError}</p>}
          </li>
        ))}
      </ul>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </section>
  );
}
