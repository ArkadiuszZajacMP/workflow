import type { Db } from '@/core/db/client';
import { type Item, items, type NewItem } from '@/core/db/schema';

export function seedItem(db: Db, overrides: Partial<NewItem> = {}): Item {
  return db
    .insert(items)
    .values({ category: 'triage', title: 'Seeded item', createdAt: 1_000, updatedAt: 1_000, ...overrides })
    .returning()
    .get();
}
