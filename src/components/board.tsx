import type { Category, Item } from '@/core/db/schema';
import type { PrRollup } from '@/core/work/planned-prs';
import { groupByCategory } from '@/lib/board';
import { CATEGORY_LABELS } from '@/lib/format';
import { ItemCard } from './item-card';

export function Board({
  items,
  columns,
  hrefFor,
  now,
  rollups,
}: {
  items: Item[];
  columns: readonly Category[];
  hrefFor: (id: number) => string;
  now: number;
  rollups: Record<number, PrRollup>;
}) {
  return (
    <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(16rem, 1fr))` }}>
      {groupByCategory(items, columns).map((column) => (
        <section key={column.category} className="space-y-3 rounded-lg bg-muted/40 p-3">
          <h2 className="flex items-center justify-between text-sm font-semibold">
            {CATEGORY_LABELS[column.category]}
            <span className="text-muted-foreground">{column.items.length}</span>
          </h2>
          {column.items.map((item) => (
            <ItemCard key={item.id} item={item} href={hrefFor(item.id)} now={now} rollup={rollups[item.id]} />
          ))}
        </section>
      ))}
    </div>
  );
}
