/**
 * Who is entitled to which change.
 *
 * A module of its own so the live fan-out and the reconnect replay call the
 * *same* function rather than two implementations that agree today. The first
 * thing two implementations would drift on is the directory filter, and a
 * replay missing that hands every Office Panel the whole staff list and every
 * role's complete permission array — precisely what the live path refuses by
 * name.
 */

import type { ChangedEntity, DataChangedEvent, Permission, PartyAccessLevel } from '@orderbook/shared';

import { actorCan, type ActorContext } from '../domain/actor.js';
import { levelFor, resolvePartyScope } from '../domain/party-scope.js';

/**
 * Never sent to an Office Panel.
 *
 * Broadcasting a `user` row handed every paired panel the whole staff list —
 * username, display name, role, tier, active flag, last sign-in — and every
 * role's complete permission array, with no per-recipient check, while the
 * equivalent *request* path correctly requires `users.manage`. No panel
 * consumes these events, so withholding them costs nothing.
 */
export const DIRECTORY_ENTITIES = new Set<ChangedEntity>(['role', 'user', 'document_export']);

/**
 * Entities whose rows hang off one party, and therefore cannot be broadcast to
 * a room — each recipient's own party scope decides whether the row is theirs.
 */
export const PARTY_SCOPED_ENTITIES = new Set<ChangedEntity>([
  'lead',
  'order',
  'party',
  'party_variant',
]);

/** Changes that move a number on the dashboard. */
export const DASHBOARD_ENTITIES = new Set<ChangedEntity>([
  'lead',
  'order',
  'party',
  'product',
  'catalog',
  'stock',
  'sync_conflict',
]);

/** The party a change belongs to, or null when it belongs to none. */
export function partyIdOfChange(event: DataChangedEvent): string | null {
  if (event.entity === 'party') return event.id;

  const payload = event.payload as { partyId?: unknown } | null;
  return typeof payload?.partyId === 'string' ? payload.partyId : null;
}

/**
 * The ordinary module permission a change requires, on top of any party
 * scoping — the same permission the request path for that entity already
 * enforces (`leadService.listLeads` needs `leads.view`, `snapshot.service.ts`
 * returns an empty collection without it, and so on).
 *
 * Without this, a role built from the shipped office-tier templates
 * (`shared/src/domain/permissions.ts`'s `roleTemplate.dispatch`, for
 * instance, which deliberately omits `leads.view`/`parties.view`) still
 * received every live `lead`/`product`/`stock` change over the socket: party
 * scoping alone says nothing about whether the *module* is visible at all,
 * and an unrestricted party (the common case — no grants recorded) used to
 * skip every check and broadcast unconditionally. Entities absent from this
 * map (`pipeline`, `option_list`, `custom_field`, `office_panel`,
 * `reservation`) carry no such module gate — they are shared reference data
 * every signed-in actor may see.
 */
export const REQUIRED_PERMISSION: Partial<Record<ChangedEntity, Permission>> = {
  lead: 'leads.view',
  order: 'orders.view',
  party: 'parties.view',
  party_variant: 'parties.view',
  product: 'products.view',
  product_category: 'products.view',
  // A bulk import's single "the catalogue moved" event: the same gate as the
  // rows it stands for.
  catalog: 'products.view',
  stock: 'inventory.view',
  sync_conflict: 'sync.resolveConflicts',
};

/**
 * Whether one recipient is entitled to one change.
 *
 * `grants` is the party's grant rows, and is ignored for anything that does not
 * hang off a party. An empty list means the party is unrestricted, which
 * `levelFor` reads as `manage` for everybody — the rule the whole Party Access
 * feature turns on. Party scoping and the module permission above are both
 * checked; either one refusing is a refusal.
 */
export function mayReceive(
  actor: ActorContext,
  event: DataChangedEvent,
  grants: ReadonlyArray<{ userId: string; level: PartyAccessLevel }>,
): boolean {
  if (DIRECTORY_ENTITIES.has(event.entity)) return false;

  const required = REQUIRED_PERMISSION[event.entity];
  if (required && !actorCan(actor, required)) return false;

  if (!PARTY_SCOPED_ENTITIES.has(event.entity)) return true;

  return levelFor(resolvePartyScope(actor), grants) !== 'none';
}
