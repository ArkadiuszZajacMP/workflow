import { AutoRefresh } from '@/components/auto-refresh';
import { Board } from '@/components/board';
import { ItemSheet } from '@/components/item-sheet';
import { StatusHeader } from '@/components/status-header';
import { getDb } from '@/core/db/client';
import { getItemDetail, getQueueStatus, listItems } from '@/core/queries';
import { BOARD_COLUMNS } from '@/lib/board';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<{ item?: string; dismissed?: string }>;

export default async function Page({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const db = getDb();
  const now = Date.now();
  const showDismissed = params.dismissed === '1';
  const base = showDismissed ? '/?dismissed=1&' : '/?';

  const itemId = Number(params.item);
  const detail = Number.isInteger(itemId) && itemId > 0 ? getItemDetail(db, itemId) : null;
  const closeHref = showDismissed ? '/?dismissed=1' : '/';

  return (
    <div className="flex min-h-screen flex-col">
      <AutoRefresh />
      <StatusHeader status={getQueueStatus(db)} now={now} showDismissed={showDismissed} />
      <main className="flex-1 overflow-x-auto p-6">
        <Board
          items={listItems(db, showDismissed ? { category: 'dismissed' } : {})}
          columns={showDismissed ? ['dismissed'] : BOARD_COLUMNS}
          hrefFor={(id) => `${base}item=${id}`}
          now={now}
        />
      </main>
      {detail && <ItemSheet key={detail.item.id} detail={detail} closeHref={closeHref} />}
    </div>
  );
}
