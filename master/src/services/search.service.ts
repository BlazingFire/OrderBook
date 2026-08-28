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

import type { SearchHit, SearchHitKind, SearchQuery } from '@orderbook/shared';

import { actorCan, requirePermission, type ActorContext } from '../domain/actor.js';
import { clampLimit } from '../domain/paging.js';
import { resolvePartyScope } from '../domain/party-scope.js';
import * as searchRepo from '../repositories/search.repository.js';

const PAGING = { defaultLimit: 20, maxLimit: 100 };

/** Which permission each searchable entity sits behind. */
const REQUIRED_PERMISSION = {
  product: 'products.view',
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
 * Search restricted to one entity, for callers that know what they want (the
 * Add Lead product picker, for example). Refuses rather than filters, because
 * a caller naming a single kind is asking a direct question.
 */
export async function searchKind(
  kind: SearchHitKind,
  query: SearchQuery,
  actor: ActorContext,
): Promise<SearchHit[]> {
  requirePermission(actor, REQUIRED_PERMISSION[kind]);
  return search({ ...query, kinds: [kind] }, actor);
}
