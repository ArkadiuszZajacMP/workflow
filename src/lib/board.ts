import type { Category, Item } from '@/core/db/schema';

export const BOARD_COLUMNS = ['triage', 'in_progress', 'verification', 'done'] as const satisfies readonly Category[];

export function groupByCategory(items: Item[], columns: readonly Category[]): { category: Category; items: Item[] }[] {
  return columns.map((category) => ({ category, items: items.filter((i) => i.category === category) }));
}
