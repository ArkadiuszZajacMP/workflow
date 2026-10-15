'use client';

import { useEffect, useState } from 'react';
import { stopRunAction } from '@/app/actions';
import { Button } from '@/components/ui/button';
import { useActionRunner } from './use-action-runner';

type RunLog = { outcome: string; summary: string | null; lines: string[] };

export function RunPanel({ itemId, runId, kind, canStop }: { itemId: number; runId: number; kind: string; canStop: boolean }) {
  const [log, setLog] = useState<RunLog | null>(null);
  const { pending, error, run } = useActionRunner();
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let inFlight = false;
    const load = async () => {
      if (inFlight || document.hidden) return;
      inFlight = true;
      try {
        const res = await fetch(`/runs/${runId}`, { cache: 'no-store' });
        if (cancelled || !res.ok) return;
        const next = (await res.json()) as RunLog;
        if (cancelled) return;
        setLog(next);
        if (next.outcome !== 'running' && timer) {
          clearInterval(timer);
          timer = undefined;
        }
      } catch {
        // transient fetch failure: keep polling
      } finally {
        inFlight = false;
      }
    };
    void load();
    timer = setInterval(load, 3_000);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [runId]);
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">Running: {kind}</h3>
        {canStop && (
          <Button size="sm" variant="destructive" className="ml-auto" disabled={pending} onClick={() => run(() => stopRunAction(itemId))}>
            Stop run
          </Button>
        )}
      </div>
      <pre role="log" aria-live="polite" className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-xs">
        {log?.lines.length ? log.lines.join('\n') : 'Waiting for output…'}
      </pre>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </section>
  );
}
