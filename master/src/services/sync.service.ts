/**
 * Applying an Office Panel's offline outbox (docs/LEAD_GENERATION_FLOW.md §4.5, §7).
 *
 * Three properties this has to deliver, and how:
 *
 *  **Deterministic numbering.** Every push goes through the push gate
 *  (`push-gate.ts`), which gathers the pushes that arrive together and applies
 *  them one mutation at a time in `(hlc, deviceCode, mutationId)` order. Panels
 *  pushing within one gather window are numbered by HLC whatever order they
 *  arrived in; a push that arrives later is numbered later.
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
 * takes a per-field clock — so they run against the repositories here. Stage
 * moves are delegated with the mutation's clock, so a stale one becomes a
 * conflict rather than overwriting a newer stage.
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
  baseForUnversionedEdit,
  columnPatch,
  ProductValidationError,
  validateProductInput,
  compareForIdAssignment,
  isSyncableEntity,
  isTemporaryId,
  type MergeableEntity,
  mergeFields,
  MUTATION_PERMISSIONS,
  type Permission,
} from '@orderbook/shared';

import { actorCan, type ActorContext } from '../domain/actor.js';
import type { LineDraft } from '../domain/line-items.js';
import { MASTER_MERGE_COLUMNS } from '../domain/merge-columns.js';
import { UNSCOPED_PARTY_ACCESS } from '../domain/party-scope.js';
import { assertStageMove } from '../domain/pipeline.js';
import { requirePartyAccess } from './party-access.service.js';
import { db } from '../db/knex.js';
import {
  AppError,
  ForbiddenError,
  NotFoundError,
  StaleEditError,
  toErrorMessage,
  ValidationError,
} from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import * as activityLog from '../repositories/activity-log.repository.js';
import * as identityRepo from '../repositories/identity.repository.js';
import * as leadRepo from '../repositories/lead.repository.js';
import * as orderRepo from '../repositories/order.repository.js';
import * as partyRepo from '../repositories/party.repository.js';
import * as pipelineRepo from '../repositories/pipeline.repository.js';
import * as userRepo from '../repositories/user.repository.js';
import * as productRepo from '../repositories/product.repository.js';
import * as productVariantRepo from '../repositories/product-variant.repository.js';
import * as syncRepo from '../repositories/sync.repository.js';
import type { TransactionContext } from '../repositories/transaction.js';
import { publishChange, publishConflict } from './change-bus.js';
import * as catalogService from './catalog.service.js';
import * as inventoryService from './inventory.service.js';
import * as leadService from './lead.service.js';
import * as orderService from './order.service.js';
import { runPush, type PostCommit } from './push-gate.js';

const log = createLogger('sync');

/**
 * Which permission each mutation kind sits behind.
 *
 * Lives in `@orderbook/shared` because the Office Panel enforces the same table
 * locally while it is offline; see the note on `MUTATION_PERMISSIONS`.
 */
const REQUIRED_PERMISSION: Record<Mutation['kind'], Permission> = MUTATION_PERMISSIONS;

/** The first panel protocol whose stage moves are ordered by their HLC (rule 6). */
const STAGE_CLOCK_MIN_PROTOCOL = 3;

/**
 * Answer one push. The checks that concern the whole push and the replayed
 * duplicates are settled here; everything else waits its turn in the push
 * gate, which hands each mutation to `applyOne`.
 */
export async function applyPush(
  request: SyncPushRequest,
  actor: ActorContext,
  /** When the pushing panel's socket connected; the push gate's backlog rule needs it. */
  connectedAt?: number,
  /**
   * The pushing panel's protocol. Absent means a caller without a socket (a
   * test), judged like the current build.
   */
  panelProtocol?: number,
): Promise<SyncPushResponse> {
  const mutations = [...(request.mutations ?? [])].sort(compareForIdAssignment);

  // A push under the panel's own role that carries a person's work the panel
  // role cannot do would be refused and recorded permanently. That person's
  // session is usually just not upgraded yet, so ask the panel to retry rather
  // than lose it. Work the panel role may do still applies as before.
  if (
    actor.actorType === 'office_panel' &&
    mutations.some(
      (m) => m.actorUserId && !actorCan(actor, REQUIRED_PERMISSION[m.kind] as Permission),
    )
  ) {
    throw new AppError('error.unavailable.signInToSync', {}, 503, 'unavailable');
  }

  const alreadyApplied = await syncRepo.findAppliedMutations(
    actor.tenantId,
    mutations.map((mutation) => mutation.mutationId),
  );

  const fresh = mutations.filter((mutation) => !alreadyApplied.has(mutation.mutationId));
  // Stage moves are ordered by their HLC only for an Office that folds the
  // Master's change clocks into its own (protocol 3 on). An older Office never
  // sees a live Master-side move's clock, so a slow clock there would turn its
  // live drags into conflicts; its moves keep the old last-arrival rule.
  const stageClock = panelProtocol === undefined || panelProtocol >= STAGE_CLOCK_MIN_PROTOCOL;
  const apply = (mutation: Mutation, pushActor: ActorContext, afterCommit: PostCommit[]) =>
    applyOne(mutation, pushActor, afterCommit, stageClock);
  const outcomes = fresh.length > 0 ? await runPush(actor, fresh, apply, connectedAt) : new Map<string, MutationResult>();

  const results: MutationResult[] = [];
  const temporaryIds: string[] = [];

  for (const mutation of mutations) {
    const previous = alreadyApplied.get(mutation.mutationId);
    if (previous) {
      results.push({ ...previous, status: 'duplicate' });
      continue;
    }

    const result = outcomes.get(mutation.mutationId);
    if (!result) throw new Error(`Push gate returned no result for ${mutation.mutationId}`);
    results.push(result);

    // Fed back into the same map, so a mutation id repeated *within one batch*
    // is reported as the duplicate it is. The gate applies each id once; two
    // copies in one request used to apply twice — two leads from one
    // `lead.create` — while the second `applied_mutations` insert was
    // swallowed by `onConflict().ignore()` and left no trace.
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

/**
 * Apply one mutation, recording its outcome. Called only by the push gate, one
 * at a time. Work that must wait for the commit (`publishConflict`) is pushed
 * onto `afterCommit`, which the gate runs once this returns.
 */
async function applyOne(
  mutation: Mutation,
  actor: ActorContext,
  afterCommit: PostCommit[],
  stageClock = true,
): Promise<MutationResult> {
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
   * This holds one pooled connection idle for the mutation's full `route()`,
   * which takes others; the push gate applies one mutation at a time, so only
   * one connection is ever held this way.
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
      result = await route(mutation, actor, afterCommit, stageClock);
    } catch (error) {
      // A transient failure — a serialization/deadlock abort from crossing
      // another transaction's lock order, or a pool-acquire timeout under a
      // burst — is not this mutation's fault and is not permanent the way a
      // validation or permission refusal is. Recording it below would make
      // `applied_mutations` replay the same rejection forever and destroy an
      // offline edit that only needed a retry. Rethrown instead, so it
      // fails this push in the gate (its later mutations are skipped, not
      // recorded) and the panel's own push retry is what runs next.
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

async function route(
  incoming: Mutation,
  actor: ActorContext,
  afterCommit: PostCommit[],
  stageClock: boolean,
): Promise<MutationResult> {
  const mutation = await resolvePayloadIds(incoming, actor);

  switch (mutation.kind) {
    case 'lead.create': {
      const lead = await leadService.createLead(payloadAs<LeadInput>(mutation), actor, mutation.hlc);
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
      return mergeUpdate('lead', mutation, actor, afterCommit);
    case 'order.update':
      return mergeUpdate('order', mutation, actor, afterCommit);
    case 'party.update':
      return mergeUpdate('party', mutation, actor, afterCommit);
    case 'product.update':
      return mergeUpdate('product', mutation, actor, afterCommit);

    case 'lead.setStage':
      return stageChange('lead', mutation, actor, afterCommit, stageClock);

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

    case 'order.setStage':
      return stageChange('order', mutation, actor, afterCommit, stageClock);

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
 * A stage move from the outbox, ordered by its HLC like a field edit (rule 6).
 * A move older than the stored stage is not applied: the service throws
 * `StaleEditError` before writing, and the move is recorded as a `stageId`
 * conflict someone can restore. Without `stageClock` (an Office older than
 * protocol 3) the move applies on arrival, as it always did.
 */
async function stageChange(
  entity: 'lead' | 'order',
  mutation: Mutation,
  actor: ActorContext,
  afterCommit: PostCommit[],
  stageClock: boolean,
): Promise<MutationResult> {
  const id = await identityRepo.resolveId(actor.tenantId, mutation.entityId);
  const input = { ...payloadAs<StageChangeInput>(mutation), id };
  const edit = stageClock ? { hlc: mutation.hlc, deviceCode: mutation.deviceCode } : undefined;

  try {
    if (entity === 'lead') await leadService.setStage(input, actor, edit);
    else await orderService.setStage(input, actor, edit);
    return applied(mutation, id);
  } catch (error) {
    if (!(error instanceof StaleEditError)) throw error;
    const { conflict } = error;
    const stored = await db().transaction((trx) =>
      syncRepo.recordConflicts(
        [
          {
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
          },
        ],
        trx,
      ),
    );
    afterCommit.push(() => stored.forEach((row) => publishConflict(row)));
    return { mutationId: mutation.mutationId, status: 'merged', entityId: id, conflicts: [conflict] };
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
  afterCommit: PostCommit[],
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

    const columns = MASTER_MERGE_COLUMNS[entity] as Record<string, string>;
    // `variants` is not a column — it is a child table replaced as a set —
    // but it merges like one field: the whole set wins or loses by HLC, and
    // a losing set is recorded as one conflict a person can put back. A
    // lead's `items` are the same thing.
    let fields = mutation.fields.filter(
      (field) =>
        field in columns ||
        (entity === 'product' && field === 'variants') ||
        (entity === 'lead' && field === 'items'),
    );

    assertMergeUnlocked(entity, current.values, fields);

    // The offline form never sends an owner, but a hand-built push could; an
    // online edit needs `record.reassignOwner` for it, so the merge drops it
    // rather than becoming the way around that.
    if (entity === 'lead' && !actorCan(actor, 'record.reassignOwner')) {
      fields = fields.filter((field) => field !== 'ownerId');
    }

    if (entity === 'lead' && fields.includes('items')) {
      // Before the merge, so a malformed set is refused rather than recorded
      // as a conflict nobody could restore.
      leadService.assertLineDrafts(mutation.payload.items);
      // The Office sends the whole form on every edit. Lines identical to the
      // stored set are not an edit: dropping them keeps a notes-only change
      // from rewriting the lines and bumping their clock.
      if (sameLines(current.values.items, mutation.payload.items)) {
        fields = fields.filter((field) => field !== 'items');
      }
    }

    // Lead and order edits from the Office carry no base (see
    // `baseForUnversionedEdit`). Parties and products send real bases and are
    // untouched.
    let base: Record<string, string> = { ...(mutation.baseFieldHlc ?? {}) };
    if ((entity === 'lead' || entity === 'order') && Object.keys(base).length === 0) {
      base = baseForUnversionedEdit(fields, current.fieldHlc, mutation.hlc);
    }

    const outcome = mergeFields(
      { values: current.values, fieldHlc: current.fieldHlc },
      {
        fields,
        values: mutation.payload,
        baseFieldHlc: base,
        hlc: mutation.hlc,
        deviceCode: mutation.deviceCode,
      },
    );

    // An `items` clash is reported only when the incoming set lost. When it
    // won, the "losing" side is the stored line rows, which are not an
    // editable value anybody could put back.
    outcome.conflicts = outcome.conflicts.filter(
      (conflict) => !(conflict.field === 'items' && conflict.winningHlc === mutation.hlc),
    );

    if (entity === 'product' && 'categoryId' in outcome.accepted) {
      const categoryId = outcome.accepted.categoryId;
      const live =
        categoryId === current.values.categoryId ||
        (typeof categoryId === 'string' &&
          (await productRepo.findCategoryById(actor.tenantId, categoryId, trx)) !== null);
      if (!live) {
        // A stale id from a panel offline since before a category was removed.
        // Ignored, with its clock put back, so the rest of the edit lands
        // instead of the whole mutation being refused.
        delete outcome.accepted.categoryId;
        if (current.fieldHlc.categoryId) outcome.fieldHlc.categoryId = current.fieldHlc.categoryId;
        else delete outcome.fieldHlc.categoryId;
        outcome.conflicts = outcome.conflicts.filter((conflict) => conflict.field !== 'categoryId');
      }
    }

    await assertMergeAllowed(entity, current.values, outcome.accepted, actor);

    outcome.status = outcome.conflicts.length > 0 ? 'merged' : 'applied';

    const acceptedItems =
      entity === 'lead' && outcome.accepted.items !== undefined
        ? await leadService.buildLines(
            actor.tenantId,
            typeof outcome.accepted.partyId === 'string'
              ? outcome.accepted.partyId
              : String(current.values.partyId),
            outcome.accepted.items as LineDraft[],
            {
              partyWiseMode:
                typeof outcome.accepted.partyWiseMode === 'boolean'
                  ? outcome.accepted.partyWiseMode
                  : Boolean(current.values.partyWiseMode),
            },
          )
        : null;

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
    const acceptedVariants =
      entity === 'product' && Array.isArray(outcome.accepted.variants)
        ? normaliseVariants(outcome.accepted.variants)
        : null;

    if (entity === 'product') {
      try {
        validateProductInput({
          ...(outcome.accepted as unknown as ProductInput),
          // The variant rule needs to know whether the model has variants,
          // whether or not this push happens to say so.
          hasVariants:
            typeof outcome.accepted.hasVariants === 'boolean'
              ? outcome.accepted.hasVariants
              : Boolean(current.values.hasVariants),
          ...(acceptedVariants ? { variants: acceptedVariants } : {}),
        });
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

    const wrote =
      Object.keys(patch).length > 0 || acceptedVariants !== null || acceptedItems !== null;
    if (wrote) {
      await writeMergedColumns(entity, actor.tenantId, id, patch, outcome.fieldHlc, hlc, trx);
    }
    if (acceptedItems) await leadRepo.replaceLeadLines(actor.tenantId, id, acceptedItems, trx);
    if (acceptedVariants) {
      await productVariantRepo.replaceVariants(actor.tenantId, id, acceptedVariants, trx);
    }

    // The sub-product name rule (docs/catalogue/CATALOGUE_MODEL.md §5) holds
    // offline too. A rename merged here is checked on the row as written, as
    // the online edit is, so a clash rolls the merge back and comes back to
    // the panel as a refusal it can read rather than a second "1111" in OPT.
    // The same rule holds when the category changes: a name that was free in
    // the old category may be taken in the new one.
    if (
      entity === 'product' &&
      ((typeof patch.name === 'string' &&
        patch.name.toLowerCase() !== String(current.values.name ?? '').toLowerCase()) ||
        (typeof patch.category_id === 'string' && patch.category_id !== current.values.categoryId))
    ) {
      const written = await productRepo.findProductById(actor.tenantId, id, trx);
      if (written) await catalogService.assertSubProductNameFree(actor.tenantId, written, trx);
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

    /*
     * Bypassing the services also bypassed their audit entry: an offline edit
     * merged here changed the record and left nothing in the trail. Recorded
     * as the online edit of the same record is — `updated`, with `{name}`
     * where the record has one — last in this transaction, and only when
     * something was written: a merge that lost every field changed nothing.
     */
    if (wrote) {
      await activityLog.recordActivity(
        {
          tenantId: actor.tenantId,
          entityType: entity,
          entityId: id,
          action: 'updated',
          actorType: actor.actorType,
          actorId: actor.actorId,
          details: {
            ...('name' in columns ? { name: String(outcome.accepted.name ?? current.values.name ?? '') } : {}),
            fields: Object.keys(outcome.accepted),
            ...(outcome.conflicts.length > 0 ? { conflicts: outcome.conflicts.length } : {}),
          },
        },
        actor,
        trx,
      );
    }

    return { outcome, storedConflicts };
  });

  // Published only after the transaction has committed, so a panel never
  // learns about a conflict or a row change that could still have rolled back.
  // The conflicts wait for the gate, after this mutation's outcome is recorded.
  afterCommit.push(() => storedConflicts.forEach((conflict) => publishConflict(conflict)));
  await republish(entity, actor.tenantId, id);

  return {
    mutationId: mutation.mutationId,
    status: outcome.status,
    entityId: id,
    conflicts: outcome.conflicts as MutationFieldConflict[],
  };
}

/** A variant set as the repository takes it, from a merge payload or a stored conflict value. */
export function normaliseVariants(variants: unknown[]): Array<{
  id?: string;
  code: string;
  label: string | null;
  weightKg: number | null;
  sequence?: number;
}> {
  return (variants as Array<Record<string, unknown>>).map((variant) => ({
    ...(typeof variant.id === 'string' ? { id: variant.id } : {}),
    code: String(variant.code ?? ''),
    label: typeof variant.label === 'string' ? variant.label : null,
    weightKg: typeof variant.weightKg === 'number' ? variant.weightKg : null,
    ...(typeof variant.sequence === 'number' ? { sequence: variant.sequence } : {}),
  }));
}

/** Everything a person can edit on a line, for "did the lines change". */
function lineKey(line: unknown): string {
  const l = (line ?? {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null);
  return JSON.stringify([
    l.productId,
    l.variantId,
    Number(l.quantity),
    text(l.colour),
    text(l.grade),
    text(l.packaging),
    text(l.notes),
  ]);
}

function sameLines(stored: unknown, incoming: unknown): boolean {
  if (!Array.isArray(stored) || !Array.isArray(incoming) || stored.length !== incoming.length) return false;
  return stored.every((line, index) => lineKey(line) === lineKey(incoming[index]));
}

/**
 * Locks that hold before a merge reads anything: a converted lead and a
 * dispatched order are no longer editable, offline or on.
 */
export function assertMergeUnlocked(
  entity: MergeableEntity,
  values: Record<string, unknown>,
  fields: string[],
): void {
  if (fields.length === 0) return;
  if (entity === 'lead' && values.convertedOrderId) {
    throw new ValidationError('validation.lead.convertedLocked');
  }
  if (entity === 'order' && values.dispatchedAt) {
    throw new ValidationError('validation.order.dispatchedLocked');
  }
}

/**
 * The online edit's value checks, run on what the merge accepted. A merge
 * writes columns directly, so without these an offline panel would be the way
 * around every rule `updateLead` / `updateOrder` / `updateParty` enforce.
 * Normalised values are written back into `accepted`.
 */
export async function assertMergeAllowed(
  entity: MergeableEntity,
  current: Record<string, unknown>,
  accepted: Record<string, unknown>,
  actor: ActorContext,
): Promise<void> {
  if (entity === 'lead') {
    if ('sourcePlatform' in accepted) {
      const value = accepted.sourcePlatform;
      if (value !== null && typeof value !== 'string') {
        throw new ValidationError('validation.lead.sourceInvalid', { value: String(value) });
      }
      await leadService.assertSourcePlatform(
        actor.tenantId,
        value,
        typeof current.sourcePlatform === 'string' ? current.sourcePlatform : null,
      );
    }
    if ('partyId' in accepted) {
      const party =
        typeof accepted.partyId === 'string'
          ? await partyRepo.findPartyById(actor.tenantId, accepted.partyId)
          : null;
      if (!party) throw new ValidationError('validation.lead.partyMissing');
    }
    if ('stageId' in accepted && accepted.stageId !== current.stageId) {
      // The same pipeline / converted / archived rules `setStage` applies.
      const stages = await pipelineRepo.stagesFor(actor.tenantId, 'lead');
      assertStageMove(stages, String(current.stageId), String(accepted.stageId), {
        convertedOrderId: current.convertedOrderId as string | null,
      });
    }
    if ('ownerId' in accepted && accepted.ownerId !== current.ownerId) {
      const owner =
        typeof accepted.ownerId === 'string'
          ? await userRepo.findById(actor.tenantId, accepted.ownerId)
          : null;
      if (!owner) throw new ValidationError('validation.lead.ownerMissing');
    }
    if (typeof accepted.notes === 'string') accepted.notes = accepted.notes.trim() || null;
  } else if (entity === 'order') {
    const weight = accepted.totalWeightKgOverride;
    if (typeof weight === 'number' && weight < 0) {
      throw new ValidationError('validation.order.weightNegative');
    }
    if ('vehicleNumber' in accepted) {
      const vehicle = accepted.vehicleNumber;
      if (vehicle !== null && typeof vehicle !== 'string') {
        throw new ValidationError('validation.order.vehicleInvalid');
      }
      accepted.vehicleNumber = orderService.normaliseVehicleNumber(vehicle);
    }
  } else if (entity === 'party') {
    if ('name' in accepted && (typeof accepted.name !== 'string' || accepted.name.trim() === '')) {
      throw new ValidationError('validation.party.nameRequired');
    }
  }
}

/** Row-locks the merge target within the caller's transaction — see `mergeUpdate`. */
export async function lockMergeTarget(
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

export async function loadMergeTarget(
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
