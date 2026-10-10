'use client';

import { useState } from 'react';
import { discardAction, linkAction, moveAction, retryAction } from '@/app/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { Category, Item } from '@/core/db/schema';
import { CATEGORY_LABELS } from '@/lib/format';
import type { ItemActionFlags } from '@/lib/item-actions';
import { useActionRunner } from './use-action-runner';

const CATEGORY_OPTIONS = Object.keys(CATEGORY_LABELS) as Category[];
const CATEGORY_ITEMS = CATEGORY_OPTIONS.map((c) => ({ value: c, label: `Move to ${CATEGORY_LABELS[c]}` }));

export function ItemControls({ item, flags }: { item: Item; flags: ItemActionFlags }) {
  const [identifier, setIdentifier] = useState('');
  const { pending, error, run } = useActionRunner();
  return (
    <section className="space-y-3">
      {item.lastError && (
        <div className="flex items-center gap-3 rounded-md border border-destructive p-3 text-sm text-destructive">
          <span className="flex-1">{item.lastError}</span>
          {flags.canRetry && (
            <Button size="sm" variant="destructive" disabled={pending} onClick={() => run(() => retryAction(item.id))}>
              Retry
            </Button>
          )}
        </div>
      )}
      {flags.canLink && (
        <div className="flex gap-2">
          <Input placeholder="Link existing issue, e.g. ENG-123" value={identifier} onChange={(e) => setIdentifier(e.target.value)} />
          <Button variant="outline" disabled={pending || !identifier.trim()} onClick={() => run(() => linkAction(item.id, identifier))}>
            Link
          </Button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={item.category}
          items={CATEGORY_ITEMS}
          onValueChange={(v) => {
            if (v !== null && v !== item.category) run(() => moveAction(item.id, v as Category));
          }}
        >
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CATEGORY_ITEMS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {flags.canDiscard && (
          <Button variant="ghost" disabled={pending} onClick={() => run(() => discardAction(item.id))}>
            Discard
          </Button>
        )}
        {flags.busy && <span className="text-sm text-muted-foreground">Working…</span>}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </section>
  );
}
