'use client';

import { linkAction, notDuplicateAction } from '@/app/actions';
import { Button } from '@/components/ui/button';
import type { DuplicateCandidate } from '@/core/db/schema';
import { useActionRunner } from './use-action-runner';

export function DuplicatePanel({ itemId, candidates, enabled }: { itemId: number; candidates: DuplicateCandidate[]; enabled: boolean }) {
  const { pending, error, run } = useActionRunner();
  if (candidates.length === 0) return null;
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold">Possible duplicates</h3>
      {candidates.map((c) => (
        <div key={c.id} className="space-y-2 rounded-md border p-3 text-sm">
          <div className="flex items-center gap-2">
            <a className="font-mono underline-offset-4 hover:underline" href={c.url} target="_blank" rel="noreferrer">
              {c.linearIdentifier}
            </a>
            <span className="truncate">{c.title}</span>
            <span className="ml-auto text-muted-foreground">{Math.round(c.confidence * 100)}%</span>
          </div>
          <p className="text-muted-foreground">{c.reasoning}</p>
          {enabled && (
            <Button size="sm" disabled={pending} onClick={() => run(() => linkAction(itemId, c.linearIdentifier, c.linearIssueId))}>
              Link to {c.linearIdentifier}
            </Button>
          )}
        </div>
      ))}
      {enabled && (
        <Button variant="outline" size="sm" disabled={pending} onClick={() => run(() => notDuplicateAction(itemId))}>
          Not a duplicate
        </Button>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </section>
  );
}
