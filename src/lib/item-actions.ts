import type { Item } from '@/core/db/schema';

export type ItemActionFlags = {
  busy: boolean;
  canResolveDuplicate: boolean;
  canEditDraft: boolean;
  canLink: boolean;
  canRetry: boolean;
  canDiscard: boolean;
};

const JOB_DRIVEN = ['new', 'checking_duplicates', 'drafting', 'creating_issue'];

export function itemActionFlags(item: Pick<Item, 'triageState' | 'category'>, activeJob: boolean): ItemActionFlags {
  const busy = activeJob || JOB_DRIVEN.includes(item.triageState ?? '');
  const state = busy ? null : item.triageState;
  return {
    busy,
    canResolveDuplicate: state === 'duplicate_suspected',
    canEditDraft: state === 'draft_ready',
    canLink: state === 'duplicate_suspected' || state === 'draft_ready',
    canRetry: state === 'failed',
    canDiscard: item.category !== 'dismissed',
  };
}
