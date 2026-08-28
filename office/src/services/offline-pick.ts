/**
 * Answering a picker from this panel's own cached snapshot.
 *
 * The point of the whole product is that an Office PC keeps working when the
 * Master is switched off, and a picker that goes blank the moment the link
 * drops takes the Add Lead screen with it.
 *
 * Two things this must not do, and both were live defects in the design before
 * it was reviewed:
 *
 *  · It must be handed `forCurrentUser(view)`, **never** `getView()` raw. The
 *    raw view is the snapshot as the Master built it for whoever was signed in
 *    when the link last worked — it carries another person's restricted parties
 *    and it carries `rate` for somebody who has no `field.saleRate.view`.
 *  · It must gate on the session's own permissions. Offline there is no
 *    `requirePermission` to lean on; this is its counterpart, and without it the
 *    picker is the one read path with no permission check at all.
 *
 * The ranking is `pickScore`/`comparePicked` from `shared`, the same functions
 * the Master's SQL ordering mirrors, so the list does not visibly reshuffle the
 * moment a panel reconnects.
 *
 * **Honest cost.** Offline this sees `SNAPSHOT_LIMIT` rows per collection plus
 * whatever is in the outbox — not the whole catalogue. The listbox says so.
 */

import type { Party, PickKind, PickPage, PickQuery, Product, SyncSnapshot } from '@orderbook/shared';
import { PICK_DEFAULT_LIMIT, PICK_MAX_LIMIT, comparePicked, pickScore } from '@orderbook/shared';

/** Which permission each pickable kind sits behind, offline as online. */
const REQUIRED_PERMISSION: Record<PickKind, string> = {
  product: 'products.view',
  party: 'parties.view',
};

export class OfflinePickForbidden extends Error {
  constructor(readonly permission: string) {
    super(`Missing permission: ${permission}`);
    this.name = 'OfflinePickForbidden';
  }
}

function clamp(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return PICK_DEFAULT_LIMIT;
  return Math.max(1, Math.min(Math.floor(limit), PICK_MAX_LIMIT));
}

/**
 * Rank and page one collection.
 *
 * `include` rows come back whatever the term matches — the currently selected
 * row must not vanish while somebody is typing — and they are not counted
 * against `truncated`, because they are not part of the set being sampled.
 */
function pickFrom<T extends { id: string }>(
  rows: readonly T[],
  fields: (row: T) => Array<string | null | undefined>,
  label: (row: T) => string,
  query: PickQuery,
): PickPage<T> {
  const limit = clamp(query.limit);
  const term = query.term?.trim() ?? '';
  const include = new Set(query.include ?? []);

  const included = rows.filter((row) => include.has(row.id));

  const candidates = rows
    .filter((row) => !include.has(row.id))
    .map((row) => ({ row, score: pickScore(fields(row), term), label: label(row) }))
    // An empty term means "no text filter", not "no results" — that is what
    // makes the idle pinned-and-recent state work before anybody has typed.
    .filter((entry) => term === '' || entry.score > 0)
    .sort(comparePicked);

  const room = Math.max(0, limit - included.length);

  return {
    items: [...included, ...candidates.slice(0, room).map((entry) => entry.row)],
    truncated: candidates.length > room,
  };
}

export function pickFromView(
  kind: PickKind,
  query: PickQuery,
  view: SyncSnapshot,
  permissions: readonly string[],
): PickPage<Product> | PickPage<Party> {
  const required = REQUIRED_PERMISSION[kind];
  if (!permissions.includes(required)) throw new OfflinePickForbidden(required);

  if (kind === 'product') {
    return pickFrom<Product>(
      view.products,
      (product) => [product.productCode, product.name, product.alias, product.barcode, product.brand],
      (product) => product.name,
      query,
    );
  }

  return pickFrom<Party>(
    view.parties,
    (party) => [party.partyCode, party.name, party.phone, party.city],
    (party) => party.name,
    query,
  );
}
