/**
 * Universal search (docs/LEAD_GENERATION_FLOW.md §9.5, §9.6).
 *
 * Search is just another read path, so it goes through the same permission
 * engine as everything else: a caller may only search the entities they can
 * view, and results carry no rate unless they hold `field.saleRate.view`.
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
  ProductVariantPick,
  SearchHit,
  SearchHitKind,
  SearchQuery,
} from '@orderbook/shared';
import { PICK_DEFAULT_LIMIT, PICK_MAX_LIMIT } from '@orderbook/shared';

import { actorCan, requirePermission, type ActorContext } from '../domain/actor.js';
import { clampLimit } from '../domain/paging.js';
import { resolvePartyScope } from '../domain/party-scope.js';
import { stockKey } from '../domain/stock-key.js';
import { maskProduct, productVisibility } from '../domain/visibility.js';
import { mapParty, mapProduct, mapProductCategory } from '../repositories/mappers.js';
import * as reservations from '../repositories/reservation.repository.js';
import * as searchRepo from '../repositories/search.repository.js';
import { freeToSell } from './company-features.js';

const PAGING = { defaultLimit: 20, maxLimit: 100 };

/** Which permission each searchable entity sits behind. */
const REQUIRED_PERMISSION = {
  product: 'products.view',
  // A variant is a product in a colour and a stock figure, so it asks for
  // both keys rather than inventing a third. `pick` checks the second itself:
  // this map is one key per kind by shape.
  variant: 'products.view',
  // A category pick names main products; same audience as the products inside.
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
    : (Object.keys(REQUIRED_PERMISSION) as SearchHitKind[]);

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
): Promise<PickPage<Product> | PickPage<Party> | PickPage<ProductVariantPick> | PickPage<ProductCategory>> {
  requirePermission(actor, REQUIRED_PERMISSION[kind]);
  // The stock half of a variant row. Asked for separately so the 403 names the
  // key that is actually missing.
  if (kind === 'variant') requirePermission(actor, 'inventory.view');

  const limit = clampLimit(query.limit, {
    defaultLimit: PICK_DEFAULT_LIMIT,
    maxLimit: PICK_MAX_LIMIT,
  });

  const include = (query.include ?? []).filter((id) => typeof id === 'string' && id.length > 0);
  const term = query.term?.trim() ?? '';

  if (kind === 'variant') {
    const page = await searchRepo.pickVariants(actor.tenantId, { term, limit });
    // Nothing is held back while the company's free-to-sell switch is off:
    // the figure a picker shows is the floor count, as everywhere else.
    const held = (await freeToSell(actor.tenantId))
      ? await reservations.reservedTotals(actor.tenantId)
      : new Map<string, number>();
    const canSeeRates = actorCan(actor, 'field.saleRate.view');

    return {
      items: page.rows.map((row) => {
        const productId = String(row.product_id);
        const colour = String(row.colour);
        const onHand = Number(row.quantity_boxes ?? 0);
        const reserved = held.get(stockKey(productId, colour)) ?? 0;
        const rate = row.rate === null || row.rate === undefined ? null : Number(row.rate);

        const item: ProductVariantPick = {
          variantCode: (row.variant_code as string | null) ?? null,
          productId,
          productCode: String(row.product_code ?? ''),
          productName: String(row.product_name ?? ''),
          alias: (row.alias as string | null) ?? null,
          sin: (row.sin as string | null) ?? null,
          size: (row.size as string | null) ?? null,
          grade: (row.grade as string | null) ?? null,
          productType: (row.product_type as string | null) ?? null,
          weightKg:
            row.weight_kg === null || row.weight_kg === undefined ? null : Number(row.weight_kg),
          colour,
          availableBoxes: onHand - reserved,
        };

        // Absent, not null and never zero, for a role without the key — the
        // same masking rule every other rate on the wire follows.
        if (canSeeRates) item.rate = rate;
        return item;
      }),
      truncated: page.truncated,
    };
  }

  if (kind === 'product') {
    const page = await searchRepo.pickProducts(actor.tenantId, {
      term,
      limit,
      include,
      categoryId: query.categoryId,
    });
    const visible = productVisibility(actor);

    return {
      items: page.rows.map((row) => maskProduct(mapProduct(row), visible)),
      truncated: page.truncated,
    };
  }

  if (kind === 'category') {
    const page = await searchRepo.pickCategories(actor.tenantId, { term, limit, include });
    return { items: page.rows.map((row) => mapProductCategory(row)), truncated: page.truncated };
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
