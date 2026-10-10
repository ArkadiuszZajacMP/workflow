'use client';

import { useRouter } from 'next/navigation';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import type { ItemDetail } from '@/core/queries';
import { CATEGORY_LABELS, displayTitle, TRIAGE_STATE_LABELS } from '@/lib/format';
import { itemActionFlags } from '@/lib/item-actions';
import { ActivityList } from './activity-list';
import { DraftEditor } from './draft-editor';
import { DuplicatePanel } from './duplicate-panel';
import { ItemControls } from './item-controls';
import { ThreadPreview } from './thread-preview';

export function ItemSheet({ detail, closeHref }: { detail: ItemDetail; closeHref: string }) {
  const router = useRouter();
  const { item } = detail;
  const flags = itemActionFlags(item, detail.activeJob);
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
