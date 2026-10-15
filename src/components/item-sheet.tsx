'use client';

import { useRouter } from 'next/navigation';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import type { ItemDetail } from '@/core/queries';
import { CATEGORY_LABELS, displayTitle, TRIAGE_STATE_LABELS } from '@/lib/format';
import { itemActionFlags } from '@/lib/item-actions';
import { workFlags } from '@/lib/work-flags';
import { ActivityList } from './activity-list';
import { DraftEditor } from './draft-editor';
import { DuplicatePanel } from './duplicate-panel';
import { ItemControls } from './item-controls';
import { ThreadPreview } from './thread-preview';
import { PlanEditor } from './plan-editor';
import { PrsPanel } from './prs-panel';
import { RunPanel } from './run-panel';
import { WorkPanel } from './work-panel';

export function ItemSheet({
  detail,
  closeHref,
  knownRepos,
  now,
}: {
  detail: ItemDetail;
  closeHref: string;
  knownRepos: string[];
  now: number;
}) {
  const router = useRouter();
  const { item } = detail;
  const flags = itemActionFlags(item, detail.activeJob);
  const work = workFlags({
    item,
    activeJob: detail.activeJob,
    activeRun: detail.activeRun !== null,
    workspace: detail.workspace,
    hasPlan: detail.plans.length > 0,
  });
  return (
    <Sheet open onOpenChange={(open) => !open && router.push(closeHref, { scroll: false })}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>{displayTitle(item)}</SheetTitle>
          <SheetDescription>
            #{item.id} · {CATEGORY_LABELS[item.category]}
            {item.triageState && ` · ${TRIAGE_STATE_LABELS[item.triageState]}`}
            {item.linearUrl && (
              <>
                {' · '}
                <a className="underline-offset-4 hover:underline" href={item.linearUrl} target="_blank" rel="noreferrer">
                  {item.linearIdentifier}
                </a>
              </>
            )}
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-6 px-4 pb-6">
          <ItemControls item={item} flags={flags} />
          <WorkPanel item={item} workspace={detail.workspace} flags={work} />
          {detail.activeRun && (
            <RunPanel key={detail.activeRun.id} itemId={item.id} runId={detail.activeRun.id} kind={detail.activeRun.kind} canStop={work.canStop} />
          )}
          <PlanEditor
            itemId={item.id}
            plans={detail.plans}
            editable={work.canEditPlan}
            knownRepos={knownRepos}
            canApprove={work.canApprove}
            linearUrl={item.linearUrl}
            planCommentId={item.planCommentId}
          />
          <PrsPanel itemId={item.id} prs={detail.plannedPrs} runs={detail.runs} now={now} canFix={work.canFix} />
          <ThreadPreview item={item} />
          <DuplicatePanel itemId={item.id} candidates={detail.candidates} enabled={flags.canResolveDuplicate} />
          <DraftEditor itemId={item.id} drafts={detail.drafts} editable={flags.canEditDraft} />
          <Separator />
          <ActivityList activity={detail.activity} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
