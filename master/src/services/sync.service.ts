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
import { canEditCost, canEditRates } from '../domain/visibility.js';
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
import type { TransactionContext } from '../repositories/transaction.js';
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
    serverHlc: await identityRepo.peekHlc(),
  };
}

/**
 * Two-argument advisory-lock namespace for serialising concurrent applications
 * of the *same* mutation id — distinct from `access-guard.repository.ts`'s
 * `ACCESS_GUARD_NAMESPACE` (4711) and the single-argument space the
 * `activity_log` chain triggers use, so this never serialises against either
 * of those for no reason.
 */
const SYNC_MUTATION_NAMESPACE = 4712;

/** Postgres serialization failure / deadlock, or a pool-acquire timeout — see `applyOne`'s catch. */
function isRetryableDatabaseError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (code === '40001' || code === '40P01') return true;
  return (error as { name?: string } | null)?.name === 'TimeoutAcquiringConnection';
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

  /*
   * Fold the panel's clock into the Master's before anything is stamped, so
   * Master-side writes that follow this batch sort after it. A short,
   * separate transaction on purpose, committed before the advisory-locked one
   * below even opens: `observeAndNextHlc` takes `master_clock`'s own row lock
   * (`FOR UPDATE`), and every write `route()` makes below stamps a fresh HLC
   * of its own — on a *different* connection, via the very same lock. Holding
   * this transaction open across `route()` would have this call deadlock
   * against itself: the outer transaction waiting for `route()` to finish
   * while `route()` waits for a clock lock the outer transaction is still
   * holding.
   */
  await db().transaction(async (trx) => {
    await identityRepo.observeAndNextHlc(trx, mutation.hlc);
  });

  /*
   * `alreadyApplied` in `applyPush` only catches a duplicate mutation id
   * *within one batch*. Two separate `applyPush` calls for the same mutation
   * — an old socket's still-running push racing a reconnected socket's resend
   * of the same unsettled outbox — read `applied_mutations` before either has
   * written it, and both proceeded to `route()` before this lock existed.
   *
   * The advisory lock is taken on this transaction's own connection and held
   * for its whole life, so a second caller for the same mutation id blocks
   * here until the first commits — including its `recordAppliedMutation`
   * write below — and then finds the row on its own re-check. `route()` is
   * left free to open its own separate transactions for the actual writes
   * (exactly as it already does for creates and merges); the lock only needs
   * this outer transaction to stay open, not the writes to run inside it.
   * Holding one pooled connection idle for a mutation's full `route()` is an
   * accepted cost at this product's LAN, one-panel-batch-at-a-time scale.
   */
  return db().transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(?, hashtext(?))', [
      SYNC_MUTATION_NAMESPACE,
      `${actor.tenantId}:${mutation.mutationId}`,
    ]);

    const already = await syncRepo.findAppliedMutations(actor.tenantId, [mutation.mutationId], trx);
    const previous = already.get(mutation.mutationId);
    if (previous) return { ...previous, status: 'duplicate' };

    let result: MutationResult;
    try {
      result = await route(mutation, actor);
    } catch (error) {
      // A transient failure — a serialization/deadlock abort from crossing
      // another transaction's lock order, or a pool-acquire timeout under a
      // burst — is not this mutation's fault and is not permanent the way a
      // validation or permission refusal is. Recording it below would make
      // `applied_mutations` replay the same rejection forever and destroy an
      // offline edit that only needed a retry. Rethrown instead, so it
      // propagates out of `applyPush` and the panel's own push retry (not a
      // recorded refusal) is what runs next.
      if (isRetryableDatabaseError(error)) throw error;

      log.warn(`Mutation ${mutation.mutationId} (${mutation.kind}) rejected: ${toErrorMessage(error)}`);
      const missing = error instanceof ForbiddenError ? error.permission : undefined;
      // Recorded even though it failed: a panel replaying the batch must get
      // the same refusal rather than a second attempt with different data
      // around it.
      result = reject(mutation, toErrorMessage(error), missing);
    }

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

    return result;
  });
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

/**
 * Payload keys that may carry a record id a panel minted offline.
 *
 * `partyId`/`ownerId`/`productId` are the scalar references; `items[].productId`
 * is the one nested reference the line-item payloads carry. Everything else in
 * a payload is a value, not a reference.
 */
const PAYLOAD_ID_KEYS = ['partyId', 'ownerId', 'productId'] as const;

/**
 * Promote every temporary id *inside* a payload to its permanent one.
 *
 * `route()` used to resolve only `mutation.entityId`, on the assumption that a
 * panel can mint a temporary id for the record being written but never for one
 * it points at. That is false for the flow the panel ships: Add Lead's inline
 * party drawer creates a party — minting `A3F9K2…` — and the lead saved
 * immediately after references it as `payload.partyId`. `lead.service.ts` does
 * an exact-match party lookup with no `id_map` fallback, threw
 * `validation.lead.partyMissing`, and `applyOne` recorded that as a *permanent*
 * rejection, so the lead was refused forever and the panel dropped it from the
 * outbox with the optimistic overlay. The lead vanished with no trace.
 *
 * Resolved for every mutation kind rather than per-case, so a kind added later
 * cannot forget: `resolveId` returns the id unchanged when `id_map` has no row,
 * so a permanent id passes through untouched. Ordering is safe — the outbox
 * preserves enqueue order, `party.create` precedes `lead.create` in the batch,
 * and `mapTemporaryId` commits its own transaction before `route()` returns.
 */
async function resolvePayloadIds(mutation: Mutation, actor: ActorContext): Promise<Mutation> {
  const map = async (value: unknown): Promise<unknown> =>
    typeof value === 'string' && isTemporaryId(value)
      ? await identityRepo.resolveId(actor.tenantId, value)
      : value;

  const payload: Record<string, unknown> = { ...mutation.payload };

  for (const key of PAYLOAD_ID_KEYS) {
    if (key in payload) payload[key] = await map(payload[key]);
  }

  if (Array.isArray(payload.items)) {
    payload.items = await Promise.all(
      payload.items.map(async (item) => {
        if (typeof item !== 'object' || item === null) return item;
        const line = item as Record<string, unknown>;
        return 'productId' in line ? { ...line, productId: await map(line.productId) } : line;
      }),
    );
  }

  return { ...mutation, payload };
}

async function route(incoming: Mutation, actor: ActorContext): Promise<MutationResult> {
  const mutation = await resolvePayloadIds(incoming, actor);

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

  /*
   * Read, decide and write inside one locked transaction — not a plain SELECT
   * followed by a separate write transaction, which is what let two
   * concurrent merges of the same record (two panels offline-editing the same
   * field, or a retried push racing an in-flight one) both read the same
   * pre-edit `fieldHlc`, both take the "ordinary sequential edit" branch, and
   * have whichever committed last silently discard the other's change with no
   * conflict ever recorded.
   *
   * `lockMergeTarget` takes the row's `FOR UPDATE` lock first; a `FOR UPDATE`
   * taken outside this same transaction would be released before the write
   * ever happened, so the read, the merge decision and the write all have to
   * share this one `trx`.
   */
  const { outcome, storedConflicts } = await db().transaction(async (trx) => {
    /*
     * `nextHlc` takes `master_clock`'s row lock and holds it to commit
     * (`identity.repository.ts#lockClock`) — every other write path stamps
     * its HLC before locking the entity row it is about to change
     * (`catalog.service.ts`, `lead.service.ts`'s ordinary updates, etc.).
     * Taking the entity lock first here and `master_clock`'s lock second
     * would put this transaction in the opposite order from those siblings:
     * two transactions racing the same row from opposite lock orders is a
     * textbook Postgres deadlock (`40P01`), and `applyOne` below records any
     * exception out of this function as a *permanent* rejection — a
     * transient deadlock would destroy the panel's offline edit rather than
     * let it retry. Stamped unconditionally, even on the branch that never
     * writes: a transaction that throws after this point rolls the stamp
     * back too, so there is no cost to taking it before the checks below
     * decide whether a write happens at all.
     */
    const hlc = await identityRepo.nextHlc(trx);

    await lockMergeTarget(entity, actor.tenantId, id, trx);

    const current = await loadMergeTarget(entity, actor.tenantId, id, trx);
    if (!current) throw new NotFoundError(entity);

    // Party Access, on the one write path that does not go through a service.
    // `route()` delegates every other mutation kind to `leadService` /
    // `orderService` / `catalogService`, which check for themselves; a merge
    // writes columns directly, so without this an offline panel would be the
    // way around the whole feature.
    await assertMergeTargetAccessible(entity, current.values, id, actor);

    const columns = MERGEABLE_COLUMNS[entity] as Record<string, string>;
    let fields = mutation.fields.filter((field) => field in columns);

    /*
     * Money fields need the same permission every other product write path
     * already enforces (`catalog.service.ts`'s createProduct/updateProduct,
     * `upsertVariant`, and the public API's `WRITE_GUARDS`) — this merge path
     * wrote `rate`/`pricePerSqft`/`purchaseRate` unconditionally, so a role
     * with `products.edit` but not `field.saleRate.edit`/
     * `field.purchaseRate.edit` could change a product's price or cost
     * through an offline sync push. Dropped from the field list rather than
     * rejected outright: `mergeFields` only ever reads `incoming.values[field]`
     * for a field present in this list, so filtering it here is what actually
     * withholds the value, matching how an offline replay silently drops any
     * other field the actor did not need to touch.
     */
    if (entity === 'product') {
      if (!canEditRates(actor)) {
        fields = fields.filter((field) => field !== 'rate' && field !== 'pricePerSqft');
      }
      if (!canEditCost(actor)) {
        fields = fields.filter((field) => field !== 'purchaseRate');
      }
    }

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
     * This function writes columns directly — it is documented as bypassing
     * the services — so a CHECK violation here is caught by `applyOne`,
     * recorded as a permanent `rejected` result, and replayed as that
     * rejection forever. An Office panel's offline edit would be destroyed
     * rather than bounced. The same `validateProductInput` the catalogue
     * service runs turns that into a refusal somebody can read and act on.
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

    if (Object.keys(patch).length > 0) {
      await writeMergedColumns(entity, actor.tenantId, id, patch, outcome.fieldHlc, hlc, trx);
    }

    let storedConflicts: Awaited<ReturnType<typeof syncRepo.recordConflicts>> = [];
    if (outcome.conflicts.length > 0) {
      storedConflicts = await syncRepo.recordConflicts(
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
    }

    return { outcome, storedConflicts };
  });

  // Published only after the transaction has committed, so a panel never
  // learns about a conflict or a row change that could still have rolled back.
  for (const conflict of storedConflicts) publishConflict(conflict);
  await republish(entity, actor.tenantId, id);

  return {
    mutationId: mutation.mutationId,
    status: outcome.status,
    entityId: id,
    conflicts: outcome.conflicts as MutationFieldConflict[],
  };
}

/** Row-locks the merge target within the caller's transaction — see `mergeUpdate`. */
async function lockMergeTarget(
  entity: MergeableEntity,
  tenantId: string,
  id: string,
  trx: TransactionContext,
): Promise<void> {
  switch (entity) {
    case 'lead':
      await leadRepo.lockLead(tenantId, id, trx);
      return;
    case 'order':
      await orderRepo.lockOrder(tenantId, id, trx);
      return;
    case 'party':
      await partyRepo.lockParty(tenantId, id, trx);
      return;
    case 'product':
      await productRepo.lockProduct(tenantId, id, trx);
      return;
  }
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
  runner: TransactionContext,
): Promise<{ values: Record<string, unknown>; fieldHlc: Record<string, string> } | null> {
  switch (entity) {
    case 'lead': {
      const lead = await leadRepo.findLeadById(tenantId, id, UNSCOPED_PARTY_ACCESS, runner);
      return lead ? { values: lead as unknown as Record<string, unknown>, fieldHlc: lead.sync.fieldHlc } : null;
    }
    case 'order': {
      const order = await orderRepo.findOrderById(tenantId, id, UNSCOPED_PARTY_ACCESS, runner);
      return order ? { values: order as unknown as Record<string, unknown>, fieldHlc: order.sync.fieldHlc } : null;
    }
    case 'party': {
      const party = await partyRepo.findPartyById(tenantId, id, runner);
      return party ? { values: party as unknown as Record<string, unknown>, fieldHlc: party.sync.fieldHlc } : null;
    }
    case 'product': {
      const product = await productRepo.findProductById(tenantId, id, runner);
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
  hlc: string,
  trx: Parameters<typeof leadRepo.updateLeadColumns>[4],
): Promise<void> {
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
