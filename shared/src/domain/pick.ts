/**
 * The searchable picker's wire contract.
 *
 * A picker is not a search box and not a `<select>`. It answers on the third
 * keystroke, it keeps whatever is already selected visible even when the search
 * term excludes it, and it tells the reader when it has stopped counting.
 *
 * Two kinds only. Leads and orders are served by their own list endpoints,
 * which already page and filter; and a `user` kind was deliberately dropped —
 * `listUsers` requires `users.manage` while the Recycle Bin's "deleted by"
 * filter is gated on `recycleBin.viewAll`, so routing that filter through a
 * pick would 403 people who have a working filter today.
 */

import type { Party, Product } from './entities.js';

export type PickKind = 'product' | 'party';

export interface PickQuery {
  term?: string;
  limit?: number;
  /**
   * Ids that must come back whatever the term matches.
   *
   * Two jobs, and both are about the picker not lying. The row that is already
   * selected must not vanish when somebody types a term it does not match, and
   * pinned rows have to be present in the idle state before any term exists.
   */
  include?: string[];
}

export interface PickPage<T> {
  items: T[];
  /**
   * True when the underlying set had more rows than `limit`.
   *
   * The listbox says so out loud. A picker that silently shows the first twenty
   * of two hundred teaches people that the thing they are looking for is not
   * there.
   */
  truncated: boolean;
}

export type ProductPickPage = PickPage<Product>;
export type PartyPickPage = PickPage<Party>;

/** How many rows a picker asks for when the caller does not say. */
export const PICK_DEFAULT_LIMIT = 20;
export const PICK_MAX_LIMIT = 50;

export function isPickKind(value: unknown): value is PickKind {
  return value === 'product' || value === 'party';
}
