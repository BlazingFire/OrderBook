/**
 * Fold one change event into a snapshot, in place.
 *
 * Pure and free of the socket, the disk and the connection, and in `shared/`
 * rather than beside the office server, because three places have to agree on
 * it: the panel's server folding a replayed or live change into its cached
 * snapshot, the panel's browser folding the same change into what it is
 * rendering, and the test that proves a replaying panel ends up holding what a
 * snapshot-taking one holds. Three implementations would drift; one cannot.
 *
 * It answers what it did. `'refresh'` means the change touched something the
 * snapshot does not hold as a flat id-keyed list — every entity in
 * `SNAPSHOT_FORCING_ENTITIES` (an option list, a pipeline, a party's own
 * version of a product, a sync conflict, a company setting and the rest) —
 * where there is no single row to upsert or filter out and one fresh pull
 * covers create, update, restore and delete alike. It is no more expensive
 * than a bespoke merge, for data this small and this rarely changed.
 *
 * **Entity is settled before action.** Reading the action first would send an
 * option-list delete into the removal path, which has no row to find and would
 * drop it silently.
 */

import type {
  Lead,
  Order,
  Party,
  Product,
  ProductCategory,
} from '../domain/entities.js';
import { SNAPSHOT_FORCING_ENTITIES, type DataChangedEvent, type SyncSnapshot } from '../protocol/socket.js';

export type ApplyOutcome = 'applied' | 'refresh' | 'ignored';

export function applyChangeToSnapshot(
  snapshot: SyncSnapshot,
  event: DataChangedEvent,
): ApplyOutcome {
  // The full set the snapshot cannot fold a single event into — not just the
  // three this used to hand-list. A live `party_variant`/`sync_conflict`
  // change fell through to 'ignored' here even though the reconnect/delta
  // path already treats both as refresh-triggering, so a connected panel
  // could keep offering a party's superseded name, size or packaging, or a
  // conflict already resolved, with no error anywhere.
  if (SNAPSHOT_FORCING_ENTITIES.includes(event.entity)) return 'refresh';

  /*
   * The `'deleted'` branch exists for the Recycle Bin, the first module to emit
   * it for `lead`/`order`/`party`/`product` — entities that actually reach a
   * panel. Every earlier `'deleted'` emission was for `role` or `user`, both
   * withheld from panels outright. Left as a blind upsert, a soft-deleted lead
   * would reappear on the panel's board seconds after somebody removed it and
   * stay there until the next full reconnect.
   */
  if (event.action === 'deleted') return removeFromSnapshot(snapshot, event);

  // 'created', 'updated' and 'restored' all converge on the same upsert.
  switch (event.entity) {
    case 'lead':
      snapshot.leads = upsert(snapshot.leads, event.payload as Lead);
      return 'applied';
    case 'party': {
      const party = event.payload as Party;
      snapshot.parties = upsert(snapshot.parties, party);
      renameParty(snapshot, party);
      return 'applied';
    }
    case 'product':
      snapshot.products = upsert(snapshot.products, event.payload as Product);
      return 'applied';
    case 'product_category':
      snapshot.categories = upsert(snapshot.categories, event.payload as ProductCategory);
      return 'applied';
    case 'order':
      snapshot.orders = upsert(snapshot.orders, event.payload as Order);
      return 'applied';
    default:
      // A Master running a newer version may broadcast entities this panel does
      // not track. Ignoring one is right; invalidating everything is not.
      return 'ignored';
  }
}

/**
 * A party's name is not stored on its leads and orders by the Master: it reads it live
 * (`pa.name as party_name`) every time it sends one. A party event carries only the party,
 * so without this a renamed party kept its old name on every lead and order the panel held
 * until that record itself next changed (or the next full snapshot). Doing it here, in the
 * one fold the panel's server, its browser and the replay test all share, fixes it for every
 * caller at once. Line items are not touched: their product, category and brand names are
 * snapshotted when the line is added, on the Master as much as here.
 */
function renameParty(snapshot: SyncSnapshot, party: Party): void {
  if (snapshot.leads.some((lead) => lead.partyId === party.id && lead.partyName !== party.name)) {
    snapshot.leads = snapshot.leads.map((lead) =>
      lead.partyId === party.id && lead.partyName !== party.name
        ? { ...lead, partyName: party.name }
        : lead,
    );
  }
  if (snapshot.orders.some((order) => order.partyId === party.id && order.partyName !== party.name)) {
    snapshot.orders = snapshot.orders.map((order) =>
      order.partyId === party.id && order.partyName !== party.name
        ? { ...order, partyName: party.name }
        : order,
    );
  }
}

function removeFromSnapshot(snapshot: SyncSnapshot, event: DataChangedEvent): ApplyOutcome {
  const { id } = event;

  switch (event.entity) {
    case 'lead':
      snapshot.leads = snapshot.leads.filter((row) => row.id !== id);
      return 'applied';
    case 'party':
      snapshot.parties = snapshot.parties.filter((row) => row.id !== id);
      return 'applied';
    case 'product':
      snapshot.products = snapshot.products.filter((row) => row.id !== id);
      return 'applied';
    // A category can be binned since catalogue v2; left as a blind upsert it
    // would stay in the panel's Products list until the next reconnect.
    case 'product_category':
      snapshot.categories = snapshot.categories.filter((row) => row.id !== id);
      return 'applied';
    case 'order':
      snapshot.orders = snapshot.orders.filter((row) => row.id !== id);
      return 'applied';
    default:
      return 'ignored';
  }
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  return upsertBy(list, item, 'id');
}

function upsertBy<T, K extends keyof T>(list: T[], item: T, key: K): T[] {
  const index = list.findIndex((entry) => entry[key] === item[key]);
  if (index === -1) return [item, ...list];

  const next = [...list];
  next[index] = item;
  return next;
}
