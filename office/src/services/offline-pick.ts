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
 *    when the link last worked — it carries another person's restricted parties.
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

import type {
  Party,
  PickKind,
  PickPage,
  PickQuery,
  Product,
  ProductCategory,
  ProductCategoryListRow,
  ProductListPage,
  ProductListQuery,
  SyncSnapshot,
} from '@orderbook/shared';
import { PICK_DEFAULT_LIMIT, PICK_MAX_LIMIT, comparePicked, pickScore } from '@orderbook/shared';

/** Which permission each pickable kind sits behind, offline as online. */
const REQUIRED_PERMISSION: Record<PickKind, string> = {
  category: 'products.view',
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

/** Catalogue order, the Master's `sort_order ASC NULLS LAST, lower(name), id`. */
function byCatalogueOrder(
  a: { id: string; sortOrder: number | null; name: string },
  b: { id: string; sortOrder: number | null; name: string },
): number {
  if (a.sortOrder !== b.sortOrder) {
    if (a.sortOrder === null) return 1;
    if (b.sortOrder === null) return -1;
    return a.sortOrder - b.sortOrder;
  }
  return a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id);
}

/** The Master's category match: the code from its start, the name or the brand anywhere. */
function categoryMatches(category: ProductCategory, term: string): boolean {
  return (
    term === '' ||
    (category.code ?? '').toLowerCase().startsWith(term) ||
    category.name.toLowerCase().includes(term) ||
    (category.brand ?? '').toLowerCase().includes(term)
  );
}

/**
 * `pickFrom` for the two lists kept in a fixed order rather than ranked — the
 * product bar and the sub-product bar. Same `include` and `truncated` rules;
 * `defaultLimit` is what the Master answers when the caller names none.
 */
function pickInOrder<T extends { id: string }>(
  rows: readonly T[],
  matches: (row: T) => boolean,
  compare: (a: T, b: T) => number,
  query: PickQuery,
  defaultLimit: number,
): PickPage<T> {
  const limit = query.limit ? clamp(query.limit) : defaultLimit;
  const include = new Set(query.include ?? []);

  const included = rows.filter((row) => include.has(row.id));
  const candidates = rows.filter((row) => !include.has(row.id) && matches(row)).sort(compare);
  const room = Math.max(0, limit - included.length);

  return {
    items: [...included, ...candidates.slice(0, room)],
    truncated: candidates.length > room,
  };
}

/**
 * The Products list (`GET /api/categories`) when the Master is switched off:
 * the cached categories, each with how many cached sub products sit under it,
 * filtered like the Master's list (`listCategories`) and in its order.
 */
export function listCategoriesFromView(
  query: { search?: string; brand?: string },
  view: SyncSnapshot,
  permissions: readonly string[],
): ProductCategoryListRow[] {
  const required = REQUIRED_PERMISSION.category;
  if (!permissions.includes(required)) throw new OfflinePickForbidden(required);

  const counts = new Map<string, number>();
  for (const product of view.products) {
    counts.set(product.categoryId, (counts.get(product.categoryId) ?? 0) + 1);
  }

  const term = query.search?.trim().toLowerCase() ?? '';
  const brand = query.brand?.trim().toLowerCase() ?? '';

  return view.categories
    .filter((category) => category.deletedAt === null || category.deletedAt === undefined)
    .filter(
      (category) =>
        term === '' ||
        [category.code, category.name, category.brand].some((field) =>
          (field ?? '').toLowerCase().includes(term),
        ),
    )
    .filter((category) => brand === '' || (category.brand ?? '').toLowerCase() === brand)
    .sort(byCatalogueOrder)
    .map((category) => ({ ...category, subProductCount: counts.get(category.id) ?? 0 }));
}

export function pickFromView(
  kind: PickKind,
  query: PickQuery,
  view: SyncSnapshot,
  permissions: readonly string[],
): PickPage<ProductCategory> | PickPage<Product> | PickPage<Party> {
  const required = REQUIRED_PERMISSION[kind];
  if (!permissions.includes(required)) throw new OfflinePickForbidden(required);

  if (kind === 'category') {
    // Only categories that hold live products are offered — the same live
    // check the Master's own `EXISTS` clause makes, here as a set built from
    // the cached page. The order is the Master's too: a code typed in full
    // first, then catalogue order.
    const stocked = new Set(view.products.map((product) => product.categoryId));
    const term = query.term?.trim().toLowerCase() ?? '';
    const exact = (category: ProductCategory): number =>
      term !== '' && (category.code ?? '').toLowerCase() === term ? 0 : 1;
    return pickInOrder(
      view.categories.filter((category) => stocked.has(category.id)),
      (category) => categoryMatches(category, term),
      (a, b) => exact(a) - exact(b) || byCatalogueOrder(a, b),
      query,
      PICK_DEFAULT_LIMIT,
    );
  }

  if (kind === 'product') {
    const categoryId = query.categoryId?.trim();
    // The sub-product bar: every sub product of one product in the Master's
    // own catalogue order (`pickSubProducts`), not ranked, so the list does not
    // reorder itself when the link comes back.
    if (categoryId) {
      const term = query.term?.trim().toLowerCase() ?? '';
      return pickInOrder(
        view.products.filter((product) => product.categoryId === categoryId),
        (product) =>
          term === '' ||
          product.name.toLowerCase().includes(term) ||
          product.variants.some(
            (variant) => variant.isActive && variant.code.toLowerCase().startsWith(term),
          ),
        byCatalogueOrder,
        query,
        PICK_MAX_LIMIT,
      );
    }
    // The whole catalogue, ranked. The codes live on the variants, so a code
    // typed here still finds its model.
    return pickFrom<Product>(
      view.products,
      (product) => [
        ...product.variants.map((variant) => variant.code),
        product.name,
        product.alias,
        ...product.variants.map((variant) => variant.label),
      ],
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

const LIST_DEFAULT_LIMIT = 100;
const LIST_MAX_LIMIT = 500;

/**
 * The catalogue page when the Master is switched off.
 *
 * Online, the Catalog screen pages through `product:list` on the Master, which
 * sees the whole catalogue. Offline it pages through this — the cached
 * snapshot, one page per collection plus whatever the outbox holds — with the
 * same query shape, the same fields the Master's own search matches, and the
 * same facet, so the screen does not change shape when the link drops. The
 * caller stamps `offline: true` on the answer; the screen says so.
 *
 * The same two rules as `pickFromView`: it ranks the gated view it is handed,
 * never the raw snapshot, and it gates on the session's permissions.
 */
export function listProductsFromView(
  query: ProductListQuery,
  view: SyncSnapshot,
  permissions: readonly string[],
): ProductListPage {
  const required = REQUIRED_PERMISSION.product;
  if (!permissions.includes(required)) throw new OfflinePickForbidden(required);

  const limit = Math.max(
    1,
    Math.min(Math.floor(query.limit ?? LIST_DEFAULT_LIMIT) || LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT),
  );
  const offset = Math.max(0, Math.floor(query.offset ?? 0) || 0);
  const term = query.search?.trim().toLowerCase() ?? '';
  const brand = query.brand?.trim().toLowerCase() ?? '';

  const matches = (product: Product): boolean =>
    term === '' ||
    [
      product.name,
      product.alias,
      product.categoryName,
      product.categoryCode,
      product.brand,
      ...product.variants.map((variant) => variant.code),
      ...product.variants.map((variant) => variant.label),
    ].some((field) => (field ?? '').toLowerCase().includes(term));

  const missingWeight = (product: Product): boolean =>
    product.variants.some((variant) => variant.isActive && variant.weightKg === null);

  // The brand narrows before the facet, as on the Master: it decides which
  // category chips are worth offering at all.
  const searched = view.products.filter(
    (product) =>
      matches(product) &&
      (brand === '' || (product.brand ?? '').toLowerCase() === brand) &&
      (!query.missingWeight || missingWeight(product)),
  );

  // The category facet, counted before the category filter — every chip
  // stays clickable while one is selected, as on the Master.
  const counts = new Map<string, { id: string; name: string; count: number }>();
  for (const product of searched) {
    const entry = counts.get(product.categoryId);
    if (entry) entry.count += 1;
    else counts.set(product.categoryId, { id: product.categoryId, name: product.categoryName, count: 1 });
  }
  const categories = [...counts.values()].sort((a, b) => a.name.localeCompare(b.name));

  const filtered = (
    query.categoryId
      ? searched.filter((product) => product.categoryId === query.categoryId)
      : searched
  ).sort((a, b) => a.name.localeCompare(b.name));

  return {
    items: filtered.slice(offset, offset + limit),
    total: filtered.length,
    limit,
    offset,
    categories,
  };
}
