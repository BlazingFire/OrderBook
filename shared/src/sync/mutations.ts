/**
 * The offline write envelope (docs/LEAD_GENERATION_FLOW.md §4, §7).
 *
 * An Office Panel does not call the Master directly when staff press Save. It
 * appends a `Mutation` to a durable local outbox and updates its local view
 * immediately; the outbox drains to the Master whenever the link is up. That is
 * what makes "saves instantly, syncs within seconds" true rather than aspirational.
 *
 * Three properties make replay safe, which matters because a panel that crashes
 * mid-flush will send some mutations twice:
 *   · `mutationId` is client-generated, and the Master remembers applied ids.
 *   · `fields` names exactly what this edit asserts, so a merge can accept a
 *     mutation field by field instead of all-or-nothing.
 *   · `hlc` + `deviceCode` give a total order independent of arrival order.
 */

import type { IdMapping, IsoTimestamp, RecordId } from '../domain/entities.js';
import type { SyncableEntity } from './ids.js';

export const MUTATION_KINDS = [
  'lead.create',
  'lead.update',
  'lead.setStage',
  'lead.addRemark',
  'lead.convert',
  'order.update',
  'order.setStage',
  'order.dispatch',
  'party.create',
  'party.update',
  'product.create',
  'product.update',
  'partyVariant.upsert',
  'stock.inbound',
  'stock.adjust',
  'stock.setReorderLevel',
  'chat.post',
] as const;

export type MutationKind = (typeof MUTATION_KINDS)[number];

/**
 * Which permission each mutation kind sits behind.
 *
 * Shared because both ends need it and they must not disagree: an Office Panel
 * consults it to refuse a write locally — the only check that exists while the
 * Master is unreachable — and the Master consults it again on push, which is the
 * check that actually counts. Two copies would drift, and the drift would show
 * up as work a panel accepted for a whole shift and the Master then rejected.
 */
export const MUTATION_PERMISSIONS: Record<MutationKind, string> = {
  'lead.create': 'leads.create',
  'lead.update': 'leads.edit',
  'lead.setStage': 'leads.edit',
  'lead.addRemark': 'leads.edit',
  'lead.convert': 'lead.convert',
  'order.update': 'orders.edit',
  'order.setStage': 'orders.edit',
  'order.dispatch': 'orders.dispatch',
  'party.create': 'parties.create',
  'party.update': 'parties.edit',
  'product.create': 'products.create',
  'product.update': 'products.edit',
  'partyVariant.upsert': 'parties.edit',
  'stock.inbound': 'inventory.edit',
  'stock.adjust': 'stock.adjust',
  'stock.setReorderLevel': 'inventory.edit',
  'chat.post': 'chat.use',
};

export interface Mutation {
  /** Client-generated. Replaying the same id is a no-op on the Master. */
  mutationId: string;
  kind: MutationKind;
  entity: SyncableEntity;
  /** Temporary id for a create; whatever id the panel knows for an update. */
  entityId: RecordId;
  hlc: string;
  deviceCode: string;
  /** The values this edit asserts. */
  payload: Record<string, unknown>;
  /**
   * Which top-level fields the edit actually touched. A field absent from this
   * list is *not* asserted, so another panel's concurrent edit to it survives.
   */
  fields: string[];
  /**
   * Per field, the HLC the panel believed was current when the user made the
   * edit. This is what separates "overwrote a value I had already seen" (fine)
   * from "overwrote a value I never saw" (a genuine conflict) — without it,
   * every ordinary sequential edit from a second panel would be reported as a
   * clash. A field missing here means the panel believed it had never been set.
   */
  baseFieldHlc: Record<string, string>;
  actorUserId: string | null;
  createdAt: IsoTimestamp;
}

export type MutationStatus =
  /** Applied cleanly — nothing else had touched these fields. */
  | 'applied'
  /** Applied in part: at least one field lost to a higher HLC. */
  | 'merged'
  /** Already seen; the stored result is returned unchanged. */
  | 'duplicate'
  /** Refused — failed validation or a permission check. */
  | 'rejected';

/** One field that lost the merge, reported back so the panel can show it. */
export interface MutationFieldConflict {
  field: string;
  losingValue: unknown;
  winningValue: unknown;
  winningHlc: string;
  winningDeviceCode: string;
}

export interface MutationResult {
  mutationId: string;
  status: MutationStatus;
  /** The record's id after any promotion — always the permanent one if assigned. */
  entityId: RecordId;
  conflicts: MutationFieldConflict[];
  error?: string;
  /** Present on `rejected` when a permission was missing, so the UI can name it. */
  missingPermission?: string;
  /** The PO number an applied `lead.create` was given; replayed with a duplicate. */
  number?: string;
}

export interface SyncPushRequest {
  mutations: Mutation[];
}

export interface SyncPushResponse {
  results: MutationResult[];
  /** Every temporary → permanent promotion this batch produced. */
  idMappings: IdMapping[];
  /** The Master's clock after folding in the batch, so the panel can advance its own. */
  serverHlc: string;
}
