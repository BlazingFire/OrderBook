/**
 * Applying an Office Panel's offline outbox (docs/LEAD_GENERATION_FLOW.md §4.5, §7).
 *
 * Three properties this has to deliver, and how:
 *
 *  **Deterministic numbering.** The batch is sorted by `(hlc, deviceCode)`
 *  before anything is applied, so two panels reconnecting in either order
 *  produce identical permanent ids.
 *
 *  **Idempotent replay.** A panel that pushes, loses the link before the
 *  acknowledgement arrives, and pushes again on reconnect must not apply
 *  anything twice. Every mutation id is recorded and its original result
 *  replayed.
 *
 *  **Field-level merge.** Updates go through `mergeFields`, so two people
 *  editing different fields of the same lead both keep their change, and the
 *  loser of a same-field clash is recorded rather than discarded.
 *
 * Creates are delegated to the ordinary services so they get the same
 * validation an online write would, then the temporary id is mapped to the
 * permanent one the service minted. Updates cannot be delegated — no service
 * takes a per-field clock — so they run against the repositories here.
 */

import type {
  LeadConvertInput,
  LeadInput,
  Mutation,
  MutationFieldConflict,
  MutationResult,
  OrderDispatchInput,
  PartyInput,
  PartyProductVariantInput,
  ProductInput,
  RemarkInput,
  ReorderLevelInput,
  StageChangeInput,
  StockAdjustmentInput,
  StockInboundInput,
  SyncPushRequest,
  SyncPushResponse,
} from '@orderbook/shared';
import {
  columnPatch,
  ProductValidationError,
  validateProductInput,
  compareForIdAssignment,
  isSyncableEntity,
  isTemporaryId,
  MERGEABLE_COLUMNS,
  type MergeableEntity,
  mergeFields,
  MUTATION_PERMISSIONS,
  type Permission,
} from '@orderbook/shared';

import { actorCan, type ActorContext } from '../domain/actor.js';
import { UNSCOPED_PARTY_ACCESS } from '../domain/party-scope.js';
import { requirePartyAccess } from './party-access.service.js';
import { db } from '../db/knex.js';
import { ForbiddenError, NotFoundError, toErrorMessage, ValidationError } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import * as identityRepo from '../repositories/identity.repository.js';
import * as leadRepo from '../repositories/lead.repository.js';
import * as orderRepo from '../repositories/order.repository.js';
import * as partyRepo from '../repositories/party.repository.js';
import * as productRepo from '../repositories/product.repository.js';
import * as syncRepo from '../repositories/sync.repository.js';
import { publishChange, publishConflict } from './change-bus.js';
import * as catalogService from './catalog.service.js';
import * as inventoryService from './inventory.service.js';
import * as leadService from './lead.service.js';
import * as orderService from './order.service.js';

const log = createLogger('sync');

/**
 * Which permission each mutation kind sits behind.
 *
 * Lives in `@orderbook/shared` because the Office Panel enforces the same table
 * locally while it is offline; see the note on `MUTATION_PERMISSIONS`.
 */
const REQUIRED_PERMISSION: Record<Mutation['kind'], Permission> = MUTATION_PERMISSIONS;

export async function applyPush(
  request: SyncPushRequest,
  actor: ActorContext,
): Promise<SyncPushResponse> {
  const mutations = [...(request.mutations ?? [])].sort(compareForIdAssignment);

  const alreadyApplied = await syncRepo.findAppliedMutations(
    actor.tenantId,
    mutations.map((mutation) => mutation.mutationId),
  );

  const results: MutationResult[] = [];
  const temporaryIds: string[] = [];

  for (const mutation of mutations) {
    const previous = alreadyApplied.get(mutation.mutationId);
    if (previous) {
      results.push({ ...previous, status: 'duplicate' });
      continue;
    }

    const result = await applyOne(mutation, actor);
    results.push(result);

    // Fed back into the same map, so a mutation id repeated *within one batch*
    // is recognised as the duplicate it is. Reading the applied set once before
    // the loop and never updating it meant two copies in one request both
    // applied — two leads from one `lead.create` — while the second
    // `applied_mutations` insert was swallowed by `onConflict().ignore()` and
    // left no trace. Only the panel's per-enqueue `randomUUID()` was preventing
    // it, which is an accident of the client rather than a property of the
    // protocol.
    alreadyApplied.set(mutation.mutationId, result);

    if (isTemporaryId(mutation.entityId)) temporaryIds.push(mutation.entityId);
  }

  const mappings = await identityRepo.listIdMappings(actor.tenantId, temporaryIds);

  return {
    results,
    idMappings: [...mappings.entries()].map(([temporaryId, permanentId]) => ({
      tenantId: actor.tenantId,
      entity: '',
      temporaryId,
      permanentId,
      deviceCode: actor.deviceCode ?? '',
      createdAt: new Date().toISOString(),
    })),
    serverHlc: await identityRepo.currentHlc(),
  };
}

async function applyOne(mutation: Mutation, actor: ActorContext): Promise<MutationResult> {
  const permission = REQUIRED_PERMISSION[mutation.kind];

  if (!permission || !isSyncableEntity(mutation.entity)) {
    return reject(mutation, `Unknown mutation "${mutation.kind}"`);
  }

  // Checked here as well as in the panel's own process: the panel's check is a
  // courtesy to its user, this one is the actual boundary.
  //
  // Recorded like any other outcome, not returned bare — a panel replaying the
  // batch must get the same refusal back rather than have it re-evaluated,
  // which would let a role change mid-retry apply a mutation the user has since
  // been told was rejected.
  if (!actorCan(actor, permission)) {
    return record(mutation, actor, reject(mutation, `Missing permission: ${permission}`, permission));
  }

  try {
    // Fold the panel's clock into the Master's before anything is stamped, so
    // Master-side writes that follow this batch sort after it.
    await db().transaction(async (trx) => {
      await identityRepo.observeAndNextHlc(trx, mutation.hlc);
    });

    return record(mutation, actor, await route(mutation, actor));
  } catch (error) {
    log.warn(`Mutation ${mutation.mutationId} (${mutation.kind}) rejected: ${toErrorMessage(error)}`);

    const missing = error instanceof ForbiddenError ? error.permission : undefined;
    // Recorded even though it failed: a panel replaying the batch must get the
    // same refusal rather than a second attempt with different data around it.
    return record(mutation, actor, reject(mutation, toErrorMessage(error), missing));
  }
}

/** Persist a mutation's outcome so a replay returns it instead of re-running. */
async function record(
  mutation: Mutation,
  actor: ActorContext,
  result: MutationResult,
): Promise<MutationResult> {
  await db().transaction(async (trx) => {
    await syncRepo.recordAppliedMutation(
      {
        tenantId: actor.tenantId,
        mutationId: mutation.mutationId,
        entity: mutation.entity,
        entityId: result.entityId,
      },
      result,
      trx,
    );
  });

  return result;
}

/**
 * A mutation payload arrives as untyped JSON from a panel that may be running
 * an older build. Casting it to the service's input type is honest only because
 * the service validates every field before it touches the database — this
 * function exists to make that assumption visible at each call site rather than
 * scattering casts through the switch below.
 */
function payloadAs<T>(mutation: Mutation): T {
  return mutation.payload as T;
}

async function route(mutation: Mutation, actor: ActorContext): Promise<MutationResult> {

  switch (mutation.kind) {
    case 'lead.create': {
      const lead = await leadService.createLead(payloadAs<LeadInput>(mutation), actor);
      await mapTemporaryId(mutation, lead.id, actor);
      return applied(mutation, lead.id);
    }

    case 'party.create': {
      const party = await catalogService.createParty(payloadAs<PartyInput>(mutation), actor);
      await mapTemporaryId(mutation, party.id, actor);
      return applied(mutation, party.id);
    }

    case 'product.create': {
      const product = await catalogService.createProduct(payloadAs<ProductInput>(mutation), actor);
      await mapTemporaryId(mutation, product.id, actor);
      return applied(mutation, product.id);
    }

    case 'lead.update':
      return mergeUpdate('lead', mutation, actor);
    case 'order.update':
      return mergeUpdate('order', mutation, actor);
    case 'party.update':
      return mergeUpdate('party', mutation, actor);
    case 'product.update':
      return mergeUpdate('product', mutation, actor);

    case 'lead.setStage': {
      const id = await identityRepo.resolveId(actor.tenantId, mutation.entityId);
      await leadService.setStage({ ...payloadAs<StageChangeInput>(mutation), id }, actor);
      return applied(mutation, id);
    }

    case 'lead.addRemark': {
      const id = await identityRepo.resolveId(actor.tenantId, mutation.entityId);
      await leadService.addRemark({ ...payloadAs<RemarkInput>(mutation), id }, actor);
      return applied(mutation, id);
    }

    case 'lead.convert': {
      const leadId = await identityRepo.resolveId(actor.tenantId, mutation.entityId);
      const order = await orderService.convertLead(
        { ...payloadAs<LeadConvertInput>(mutation), leadId },
        actor,
      );
      return applied(mutation, order.id);
    }

    case 'order.setStage': {
      const id = await identityRepo.resolveId(actor.tenantId, mutation.entityId);
      await orderService.setStage({ ...payloadAs<StageChangeInput>(mutation), id }, actor);
      return applied(mutation, id);
    }

    case 'order.dispatch': {
      const orderId = await identityRepo.resolveId(actor.tenantId, mutation.entityId);
      await orderService.dispatchOrder(
        { ...payloadAs<OrderDispatchInput>(mutation), orderId },
        actor,
      );
      return applied(mutation, orderId);
    }

    case 'partyVariant.upsert': {
      const variant = await catalogService.upsertVariant(
        payloadAs<PartyProductVariantInput>(mutation),
        actor,
      );
      return applied(mutation, variant.id);
    }

    case 'stock.inbound': {
      await inventoryService.recordInbound(payloadAs<StockInboundInput>(mutation), actor);
      return applied(mutation, mutation.entityId);
    }

    case 'stock.adjust': {
      await inventoryService.recordAdjustment(payloadAs<StockAdjustmentInput>(mutation), actor);
      return applied(mutation, mutation.entityId);
    }

    case 'stock.setReorderLevel': {
      await inventoryService.setReorderLevel(payloadAs<ReorderLevelInput>(mutation), actor);
      return applied(mutation, mutation.entityId);
    }

    default:
      return reject(mutation, `Unhandled mutation "${mutation.kind}"`);
  }
}

/**
 * Apply an update through the field-level merge.
 *
 * Only the fields the mutation actually asserts are considered. Anything the
 * panel did not touch keeps whatever another panel wrote — which is the entire
 * reason `Mutation.fields` exists rather than diffing whole records.
 */
async function mergeUpdate(
  entity: MergeableEntity,
  mutation: Mutation,
  actor: ActorContext,
): Promise<MutationResult> {
  const id = await identityRepo.resolveId(actor.tenantId, mutation.entityId);
  const current = await loadMergeTarget(entity, actor.tenantId, id);

  if (!current) throw new NotFoundError(entity);

  // Party Access, on the one write path that does not go through a service.
  // `route()` delegates every other mutation kind to `leadService` /
  // `orderService` / `catalogService`, which check for themselves; a merge
  // writes columns directly, so without this an offline panel would be the way
  // around the whole feature.
  await assertMergeTargetAccessible(entity, current.values, id, actor);

  const columns = MERGEABLE_COLUMNS[entity] as Record<string, string>;
  const fields = mutation.fields.filter((field) => field in columns);

  const outcome = mergeFields(
    { values: current.values, fieldHlc: current.fieldHlc },
    {
      fields,
      values: mutation.payload,
      baseFieldHlc: mutation.baseFieldHlc ?? {},
      hlc: mutation.hlc,
      deviceCode: mutation.deviceCode,
    },
  );

  /*
   * Validate before writing, on the one path that has no validation layer.
   *
   * This function writes columns directly — it is documented as bypassing the
   * services — so a CHECK violation here is caught by `applyOne`, recorded as a
   * permanent `rejected` result, and replayed as that rejection forever. An
   * Office panel's offline edit would be destroyed rather than bounced. The
   * same `validateProductInput` the catalogue service runs turns that into a
   * refusal somebody can read and act on.
   */
  if (entity === 'product') {
    try {
      validateProductInput(outcome.accepted as unknown as ProductInput);
    } catch (error) {
      if (error instanceof ProductValidationError) throw new ValidationError(error.messageKey);
      throw error;
    }
  }

  const patch = columnPatch(outcome.accepted, columns);

  // A merge that moves a lead or order onto another party has to clear that
  // party too, or the move itself becomes the escape hatch.
  if (typeof patch.party_id === 'string') {
    await requirePartyAccess(patch.party_id, 'manage', actor);
  }

  await db().transaction(async (trx) => {
    if (Object.keys(patch).length > 0) {
      await writeMergedColumns(entity, actor.tenantId, id, patch, outcome.fieldHlc, trx);
    }

    if (outcome.conflicts.length > 0) {
      const stored = await syncRepo.recordConflicts(
        outcome.conflicts.map((conflict) => ({
          tenantId: actor.tenantId,
          entity,
          entityId: id,
          field: conflict.field,
          losingValue: conflict.losingValue,
          losingHlc: mutation.hlc,
          losingDeviceCode: mutation.deviceCode,
          winningValue: conflict.winningValue,
          winningHlc: conflict.winningHlc,
          winningDeviceCode: conflict.winningDeviceCode,
        })),
        trx,
      );

      for (const conflict of stored) publishConflict(conflict);
    }
  });

  await republish(entity, actor.tenantId, id);

  return {
    mutationId: mutation.mutationId,
    status: outcome.status,
    entityId: id,
    conflicts: outcome.conflicts as MutationFieldConflict[],
  };
}

/**
 * The party a merge target belongs to, and whether this caller may manage it.
 *
 * `product` is not party-scoped — a product belongs to the catalogue, not to a
 * customer — so it passes through untouched rather than being given a
 * meaningless check.
 */
async function assertMergeTargetAccessible(
  entity: MergeableEntity,
  values: Record<string, unknown>,
  id: string,
  actor: ActorContext,
): Promise<void> {
  if (entity === 'product') return;
  if (entity === 'party') {
    await requirePartyAccess(id, 'manage', actor);
    return;
  }

  const partyId = values.partyId;
  if (typeof partyId === 'string') await requirePartyAccess(partyId, 'manage', actor);
}

async function loadMergeTarget(
  entity: MergeableEntity,
  tenantId: string,
  id: string,
): Promise<{ values: Record<string, unknown>; fieldHlc: Record<string, string> } | null> {
  switch (entity) {
    case 'lead': {
      const lead = await leadRepo.findLeadById(tenantId, id, UNSCOPED_PARTY_ACCESS);
      return lead ? { values: lead as unknown as Record<string, unknown>, fieldHlc: lead.sync.fieldHlc } : null;
    }
    case 'order': {
      const order = await orderRepo.findOrderById(tenantId, id, UNSCOPED_PARTY_ACCESS);
      return order ? { values: order as unknown as Record<string, unknown>, fieldHlc: order.sync.fieldHlc } : null;
    }
    case 'party': {
      const party = await partyRepo.findPartyById(tenantId, id);
      return party ? { values: party as unknown as Record<string, unknown>, fieldHlc: party.sync.fieldHlc } : null;
    }
    case 'product': {
      const product = await productRepo.findProductById(tenantId, id);
      return product
        ? { values: product as unknown as Record<string, unknown>, fieldHlc: product.sync.fieldHlc }
        : null;
    }
    default:
      return null;
  }
}

async function writeMergedColumns(
  entity: MergeableEntity,
  tenantId: string,
  id: string,
  patch: Record<string, unknown>,
  fieldHlc: Record<string, string>,
  trx: Parameters<typeof leadRepo.updateLeadColumns>[4],
): Promise<void> {
  const hlc = await identityRepo.nextHlc(trx);
  const meta = { hlc, fieldHlc };

  switch (entity) {
    case 'lead':
      return leadRepo.updateLeadColumns(tenantId, id, patch, meta, trx);
    case 'order':
      return orderRepo.updateOrderColumns(tenantId, id, patch, meta, trx);
    case 'party':
      return partyRepo.updatePartyColumns(tenantId, id, patch, meta, trx);
    case 'product':
      return productRepo.updateProductColumns(tenantId, id, patch, meta, trx);
  }
}

async function republish(
  entity: MergeableEntity,
  tenantId: string,
  id: string,
): Promise<void> {
  const payload =
    entity === 'lead'
      ? await leadRepo.findLeadById(tenantId, id, UNSCOPED_PARTY_ACCESS)
      : entity === 'order'
        ? await orderRepo.findOrderById(tenantId, id, UNSCOPED_PARTY_ACCESS)
        : entity === 'party'
          ? await partyRepo.findPartyById(tenantId, id)
          : await productRepo.findProductById(tenantId, id);

  if (payload) publishChange({ entity, action: 'updated', id, payload });
}

async function mapTemporaryId(
  mutation: Mutation,
  permanentId: string,
  actor: ActorContext,
): Promise<void> {
  if (!isTemporaryId(mutation.entityId)) return;

  await db().transaction(async (trx) => {
    await identityRepo.recordIdMapping(
      {
        tenantId: actor.tenantId,
        entity: mutation.entity,
        temporaryId: mutation.entityId,
        permanentId,
        deviceCode: mutation.deviceCode,
      },
      trx,
    );
  });
}

function applied(mutation: Mutation, entityId: string): MutationResult {
  return { mutationId: mutation.mutationId, status: 'applied', entityId, conflicts: [] };
}

function reject(mutation: Mutation, error: string, missingPermission?: string): MutationResult {
  return {
    mutationId: mutation.mutationId,
    status: 'rejected',
    entityId: mutation.entityId,
    conflicts: [],
    error,
    ...(missingPermission ? { missingPermission } : {}),
  };
}
