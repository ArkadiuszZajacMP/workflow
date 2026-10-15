'use client';

import { removeWorkspaceAction, retryWorkAction, startInvestigationAction } from '@/app/actions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { Item, Workspace } from '@/core/db/schema';
import { WORK_STATE_LABELS } from '@/lib/format';
import type { WorkFlags } from '@/lib/work-flags';
import { useActionRunner } from './use-action-runner';

export function WorkPanel({ item, workspace, flags }: { item: Item; workspace: Workspace | null; flags: WorkFlags }) {
  const { pending, error, run } = useActionRunner();
  if (!item.linearIssueId) return null;
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">Work</h3>
        {item.workState && (
          <Badge variant={item.workState === 'failed' ? 'destructive' : 'secondary'}>{WORK_STATE_LABELS[item.workState]}</Badge>
        )}
        {flags.canStart && (
          <Button size="sm" disabled={pending} onClick={() => run(() => startInvestigationAction(item.id))}>
            Start investigation
          </Button>
        )}
        {flags.canRetry && (
          <Button size="sm" variant="destructive" disabled={pending} onClick={() => run(() => retryWorkAction(item.id))}>
            Retry work
          </Button>
        )}
      </div>
      {workspace && workspace.status !== 'removed' && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>
            Workspace <span className="font-mono">{workspace.container}</span> · {workspace.status}
            {workspace.repos.length > 0 && ` · ${workspace.repos.join(', ')}`}
          </span>
          {flags.canRemoveWorkspace && (
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => removeWorkspaceAction(item.id))}>
              Remove workspace
            </Button>
          )}
        </div>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </section>
  );
}
