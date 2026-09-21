/**
 * Universal search (docs/LEAD_GENERATION_FLOW.md §9.5, §9.6).
 *
 * Search is just another read path, so it goes through the same permission
 * engine as everything else: a caller may only search the entities they can
 * view.
 *
 * This service merges the per-entity indexes; it does not maintain one of its
 * own. Adding a searchable entity later means adding its vector to the merge,
 * not building a second search system.
 */

import type {
  Party,
  PickKind,
  PickPage,
  PickQuery,
  Product,
  ProductCategory,
  SearchHit,
  SearchHitKind,
  SearchQuery,
} from '@orderbook/shared';
import { PICK_DEFAULT_LIMIT, PICK_MAX_LIMIT } from '@orderbook/shared';

import { actorCan, requirePermission, type ActorContext } from '../domain/actor.js';
import { clampLimit } from '../domain/paging.js';
import { resolvePartyScope } from '../domain/party-scope.js';
import { mapParty, mapProduct, mapProductCategory } from '../repositories/mappers.js';
import { loadVariantsFor } from '../repositories/product-variant.repository.js';
import * as searchRepo from '../repositories/search.repository.js';

const PAGING = { defaultLimit: 20, maxLimit: 100 };

/** Which permission each searchable entity sits behind. */
const REQUIRED_PERMISSION = {
  product: 'products.view',
  // A category is part of the catalogue, so it opens with the catalogue's key.
  category: 'products.view',
  party: 'parties.view',
  lead_line: 'leads.view',
  order_line: 'orders.view',
} as const;

export async function search(query: SearchQuery, actor: ActorContext): Promise<SearchHit[]> {
  const term = query.term?.trim();
  if (!term) return [];

  const requested: SearchHitKind[] = query.kinds?.length
    ? query.kinds
    : (['product', 'party', 'lead_line', 'order_line'] as SearchHitKind[]);

  // Filtered rather than refused: a search box that returns a 403 because one
  // of four indexes is off-limits would be unusable for an Office-tier user.
  const permitted = requested.filter((kind) => actorCan(actor, REQUIRED_PERMISSION[kind]));
  if (permitted.length === 0) return [];

  return searchRepo.search(actor.tenantId, {
    term,
    kinds: permitted,
    limit: clampLimit(query.limit, PAGING),
    // Search is just another read, so it narrows the same way every list does.
    // Without this it would be the one hole straight through the party scope.
    scope: resolvePartyScope(actor),
  });
}

/**
 * Rows for a searchable dropdown.
 *
 * A different operation from `search` above, not a narrowing of it. Search
 * answers "where does this word appear" across four indexes and returns
 * headline-and-subtitle hits; a picker answers "which record do you mean" for
 * one kind and returns whole records, because the thing that is chosen goes
 * straight into a line or a form.
 *
 * It **refuses** rather than filters: a caller naming a kind is asking a direct
 * question, and answering an empty list to somebody without the permission
 * would read as "there are none".
 */
export async function pick(
  kind: PickKind,
  query: PickQuery,
  actor: ActorContext,
): Promise<PickPage<ProductCategory> | PickPage<Product> | PickPage<Party>> {
  requirePermission(actor, REQUIRED_PERMISSION[kind]);

  const limit = clampLimit(query.limit, {
    defaultLimit: PICK_DEFAULT_LIMIT,
    maxLimit: PICK_MAX_LIMIT,
  });

  const include = (query.include ?? []).filter((id) => typeof id === 'string' && id.length > 0);
  const term = query.term?.trim() ?? '';

  if (kind === 'category') {
    const page = await searchRepo.pickCategories(actor.tenantId, { term, limit, include });
    return { items: page.rows.map((row) => mapProductCategory(row)), truncated: page.truncated };
  }

  if (kind === 'product') {
    const categoryId = typeof query.categoryId === 'string' ? query.categoryId.trim() : '';
    const page = await searchRepo.pickProducts(actor.tenantId, {
      term,
      limit,
      include,
      ...(categoryId ? { categoryId } : {}),
    });

    // Whole products, variants included: the third stage of the lead screen
    // (which colour, which code, which weight) needs no further round trip.
    const variants = await loadVariantsFor(
      actor.tenantId,
      page.rows.map((row) => String(row.id)),
    );

    return {
      items: page.rows.map((row) =>
        mapProduct(row, [], variants.get(String(row.id)) ?? []),
      ),
      truncated: page.truncated,
    };
  }

  const page = await searchRepo.pickParties(actor.tenantId, {
    term,
    limit,
    include,
    // Same narrowing every party read gets. There is deliberately no
    // `maskParty` — a party carries no money field, so the scope is the whole
    // of what has to be applied here.
    scope: resolvePartyScope(actor),
  });

  return { items: page.rows.map((row) => mapParty(row)), truncated: page.truncated };
}
