import { describe, expect, it } from 'vitest';
import type { Item } from '@/core/db/schema';
import { BOARD_COLUMNS, groupByCategory } from './board';

const item = (id: number, category: Item['category']) => ({ id, category }) as Item;

describe('groupByCategory', () => {
  it('returns every column in order, including empty ones, keeping item order', () => {
    const grouped = groupByCategory([item(1, 'done'), item(2, 'triage'), item(3, 'triage')], BOARD_COLUMNS);
    expect(grouped.map((g) => [g.category, g.items.map((i) => i.id)])).toEqual([
      ['triage', [2, 3]],
      ['in_progress', []],
      ['verification', []],
      ['done', [1]],
    ]);
  });
});
