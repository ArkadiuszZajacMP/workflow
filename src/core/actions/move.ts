import type { Db } from '../db/client';
import { CATEGORIES, type Category, type Item } from '../db/schema';
import { ActionError } from '../errors';
import { logActivity, requireItem, updateItem } from '../items';

export function move(db: Db, itemId: number, category: Category, now = Date.now()): Item {
  if (!CATEGORIES.includes(category)) throw new ActionError(`Unknown category "${category}"`);
  return db.transaction((tx) => {
    const item = requireItem(tx, itemId);
    if (item.category === category) return item;
    const updated = updateItem(tx, itemId, { category }, now);
    logActivity(tx, itemId, `Moved to ${category}`, now);
    return updated;
  });
}
