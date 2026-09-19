/**
 * Parties, products and party-specific variants — the master data leads are
 * built from. Validation, permissions and change publication live here; SQL
 * lives in the repositories.
 */

import type {
  BinBlocker,
  BinRestoreResult,
  ListQuery,
  Paginated,
  Party,
  PartyInput,
  PartyProductVariant,
  PartyProductVariantInput,
  Product,
  ProductCategory,
  ProductInput,
  ProductListPage,
  ProductListQuery,
  ProductVariantInput,
} from '@orderbook/shared';
import {
  columnPatch,
  fieldFor,
  PARTY_COLUMNS,
  PRODUCT_COLUMNS,
  ProductValidationError,
  validateProductInput,
} from '@orderbook/shared';

import { actorUserId, requirePermission, type ActorContext } from '../domain/actor.js';
import { clampPaging } from '../domain/paging.js';
import { resolvePartyScope } from '../domain/party-scope.js';
import { suggestRestoredName } from '../domain/recycle-bin.js';
import {
  canEditCost,
  canEditRates,
  canSeeRates,
  maskProduct,
  maskVariant,
  productVisibility,
  withPermittedPurchaseRate,
  withPermittedRate,
} from '../domain/visibility.js';
import { db } from '../db/knex.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import * as activityLog from '../repositories/activity-log.repository.js';
import { nextHlc } from '../repositories/identity.repository.js';
import * as partyRepo from '../repositories/party.repository.js';
import * as variantRepo from '../repositories/party-variant.repository.js';
import * as productRepo from '../repositories/product.repository.js';
import * as productVariantRepo from '../repositories/product-variant.repository.js';
import { publishChange } from './change-bus.js';
import { requirePartyAccess } from './party-access.service.js';

const PAGING = { defaultLimit: 100, maxLimit: 500 };

// --- Parties ---------------------------------------------------------------

export async function listParties(
  query: ListQuery,
  actor: ActorContext,
): Promise<Paginated<Party>> {
  requirePermission(actor, 'parties.view');
  return partyRepo.listParties(actor.tenantId, {
    search: query.search,
    ...clampPaging(query, PAGING),
    scope: resolvePartyScope(actor),
    filter: query.scope,
  });
}

/**
 * One party, masked and party-scoped.
 *
 * Scoped at the query like `getLead`, so a party this caller may not see is a
 * 404 and not a 403 — on a read, confirming the record exists is itself the
 * leak. Added for the public API, which needs a read-one that is not the list.
 */
export async function getParty(id: string, actor: ActorContext): Promise<Party> {
  requirePermission(actor, 'parties.view');
  await requirePartyAccess(id, 'view', actor);

  const party = await partyRepo.findPartyById(actor.tenantId, id);
  if (!party) throw new NotFoundError('Party');

  return party;
}

export async function createParty(input: PartyInput, actor: ActorContext): Promise<Party> {
  requirePermission(actor, 'parties.create');

  const name = input.name?.trim();
  if (!name) throw new ValidationError('validation.party.nameRequired');

  const party = await db().transaction(async (trx) => {
    const hlc = await nextHlc(trx);
    return partyRepo.insertParty(
      {
        tenantId: actor.tenantId,
        input: { ...input, name },
        createdByUserId: actorUserId(actor),
        hlc,
        fieldHlc: {},
        temporaryId: null,
      },
      trx,
    );
  });

  await activityLog.recordDetachedActivity(
    {
      tenantId: actor.tenantId,
      entityType: 'party',
      entityId: party.id,
      action: 'created',
      actorType: actor.actorType,
      actorId: actor.actorId,
      // The catalogue's tokens read "{actor} added the party {name}", so an entry
      // without a name renders the placeholder to the reader. The delete and
      // restore paths always carried one; create and update did not, and the
      // Activity log showed a literal `{name}` on every one of them.
      details: { name: party.name },
    },
    actor,
    db(),
  );
  publishChange({ entity: 'party', action: 'created', id: party.id, payload: party });

  return party;
}

export async function updateParty(
  id: string,
  input: PartyInput,
  actor: ActorContext,
): Promise<Party> {
  requirePermission(actor, 'parties.edit');
  await requirePartyAccess(id, 'manage', actor);

  const name = input.name?.trim();
  if (!name) throw new ValidationError('validation.party.nameRequired');

  // Read first so the write below can *merge* field_hlc rather than replace
  // it wholesale. A bare `{}` here used to discard every previously recorded
  // per-field clock — `mergeFields` treats a field with no stored clock as
  // unconditionally acceptable from an incoming edit and does not even record
  // a conflict for it (it only compares clocks it has one for), so an Office
  // Panel replaying a stale offline edit after this ran would silently
  // overwrite whatever this write just set, with no trace that anything
  // changed. `updateLead`/`updateOrder` already merge for the same reason.
  const existing = await partyRepo.findPartyById(actor.tenantId, id);
  if (!existing) throw new NotFoundError('Party');

  const merged = { ...input, name };
  const touchedColumns = Object.keys(columnPatch(merged, PARTY_COLUMNS));

  const party = await db().transaction(async (trx) => {
    const hlc = await nextHlc(trx);
    // Keyed by wire field, not column — `mergeFields` looks these up by wire
    // field (see `order.service.ts`'s identical comment on the same bug).
    const fieldHlc = { ...existing.sync.fieldHlc };
    for (const column of touchedColumns) fieldHlc[fieldFor(PARTY_COLUMNS, column)] = hlc;

    return partyRepo.updateParty(actor.tenantId, id, merged, { hlc, fieldHlc }, trx);
  });

  if (!party) throw new NotFoundError('Party');

  await activityLog.recordDetachedActivity(
    {
      tenantId: actor.tenantId,
      entityType: 'party',
      entityId: party.id,
      action: 'updated',
      actorType: actor.actorType,
      actorId: actor.actorId,
      details: { name: party.name },
    },
    actor,
    db(),
  );
  publishChange({ entity: 'party', action: 'updated', id: party.id, payload: party });

  return party;
}

/**
 * The first delete path this record has ever had. Refused while any live
 * lead or order still references it — a soft-deleted party would otherwise
 * leave those rows pointing at a tombstone.
 */
export async function deleteParty(
  id: string,
  actor: ActorContext,
): Promise<{ id: string; deletedAt: string }> {
  requirePermission(actor, 'parties.delete');
  await requirePartyAccess(id, 'manage', actor);

  const existing = await partyRepo.findPartyById(actor.tenantId, id);
  if (!existing) throw new NotFoundError('Party');

  const blockers = await partyRepo.liveReferencesToParty(actor.tenantId, id);
  if (blockers.length > 0) {
    throw new ConflictError(
      'error.conflict.blockedByLiveReferences',
      {},
      {
        blockedBy: blockers.map((b): BinBlocker => ({
          entityType: b.entityType,
          id: b.id,
          label: b.label,
          reason: 'live_reference',
        })),
      },
    );
  }

  const party = await db().transaction(async (trx) => {
    const hlc = await nextHlc(trx);
    const fieldHlc = { ...existing.sync.fieldHlc, deletedAt: hlc };
    const row = await partyRepo.softDeleteParty(
      actor.tenantId,
      id,
      actorUserId(actor),
      { hlc, fieldHlc },
      trx,
    );

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'party',
        entityId: id,
        action: 'deleted',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { name: existing.name },
      },
      actor,
      trx,
    );

    return row;
  });

  if (!party) throw new NotFoundError('Party');

  publishChange({ entity: 'party', action: 'deleted', id, payload: party });
  // `updated_at` is bumped by the same `now()` call as `deleted_at` in one
  // UPDATE, so the two are byte-identical without a second round trip.
  return { id: party.id, deletedAt: party.updatedAt };
}

export async function restoreParty(
  id: string,
  actor: ActorContext,
  renameTo: string | undefined,
): Promise<BinRestoreResult> {
  requirePermission(actor, 'parties.delete');
  // Grants outlive a soft delete, so a restore is checked like any other write
  // to the party — otherwise the Recycle Bin would be a way to put somebody
  // else's party back into your own screens.
  await requirePartyAccess(id, 'manage', actor);

  const existing = await partyRepo.findPartyById(actor.tenantId, id, db(), {
    includeDeleted: true,
  });
  if (!existing) throw new NotFoundError('Party');

  const desiredCode = renameTo ?? existing.partyCode;
  const taken = await partyRepo.isPartyCodeTaken(actor.tenantId, desiredCode, id);
  if (taken) {
    const suggestion = await suggestRestoredName(existing.partyCode, (candidate) =>
      partyRepo.isPartyCodeTaken(actor.tenantId, candidate, id),
    );
    throw new ConflictError(
      'error.conflict.restoreCollision',
      { field: 'partyCode' },
      { field: 'partyCode', value: desiredCode, suggestion },
    );
  }

  const party = await db().transaction(async (trx) => {
    const hlc = await nextHlc(trx);
    const fieldHlc = { ...existing.sync.fieldHlc, deletedAt: hlc };
    const row = await partyRepo.restoreParty(actor.tenantId, id, { hlc, fieldHlc }, trx, renameTo);

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'party',
        entityId: id,
        action: 'restored',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { name: existing.name, ...(renameTo ? { renamedCodeTo: renameTo } : {}) },
      },
      actor,
      trx,
    );

    return row;
  });

  if (!party) throw new NotFoundError('Party');

  publishChange({ entity: 'party', action: 'restored', id, payload: party });
  return { entityType: 'party', id, renamedTo: renameTo, alsoRestored: [] };
}

// --- Products --------------------------------------------------------------

export async function listProducts(
  query: ProductListQuery,
  actor: ActorContext,
): Promise<ProductListPage> {
  requirePermission(actor, 'products.view');

  const page = await productRepo.listProducts(actor.tenantId, {
    search: query.search,
    categoryId: query.categoryId,
    missingWeight: query.missingWeight,
    ...clampPaging(query, PAGING),
  });

  const visible = productVisibility(actor);
  return { ...page, items: page.items.map((product) => maskProduct(product, visible)) };
}

export async function getProduct(id: string, actor: ActorContext): Promise<Product> {
  requirePermission(actor, 'products.view');

  const product = await productRepo.findProductById(actor.tenantId, id);
  if (!product) throw new NotFoundError('Product');

  return maskProduct(product, productVisibility(actor));
}

export async function listCategories(
  actor: ActorContext,
  options: { search?: string } = {},
): Promise<ProductCategory[]> {
  requirePermission(actor, 'products.view');
  return productRepo.listCategories(actor.tenantId, db(), options);
}

/** The product behind a variant code — the "type a code" lookup, by variant now. */
export async function findProductByCode(
  code: string,
  actor: ActorContext,
): Promise<Product | null> {
  requirePermission(actor, 'products.view');

  const variant = await productVariantRepo.findVariantByCode(actor.tenantId, code);
  if (!variant) return null;
  const product = await productRepo.findProductById(actor.tenantId, variant.productId);
  return product ? maskProduct(product, productVisibility(actor)) : null;
}

/**
 * The friendly half of the duplicate-code guard: names the exact code and
 * the product that holds it. The database's partial unique index is the
 * enforcement — two people can reach it at once, so this is a better
 * message, not a substitute.
 */
async function assertCodesFree(
  tenantId: string,
  variants: readonly ProductVariantInput[],
  ownProductId: string | null,
): Promise<void> {
  const taken = await productVariantRepo.findLiveVariantsByCodes(
    tenantId,
    variants.map((variant) => variant.code),
  );
  for (const variant of variants) {
    const holder = taken.get(variant.code.trim().toLowerCase());
    if (holder && holder.productId !== ownProductId) {
      throw new ConflictError('error.conflict.productCodeTaken', { productCode: variant.code.trim() });
    }
  }
}

/** `hasVariants` as the form meant it: stated, or implied by a labelled row. */
function resolveHasVariants(input: ProductInput, fallback: boolean | null): boolean {
  if (input.hasVariants !== undefined) return input.hasVariants;
  if (input.variants !== undefined) {
    return input.variants.some((variant) => typeof variant.label === 'string' && variant.label.trim() !== '');
  }
  return fallback ?? false;
}

/**
 * Run the shared product validator and re-throw in this codebase's currency.
 *
 * The validator lives in `shared` because the offline merge path needs it too,
 * and `shared` cannot import the Master's `AppError` hierarchy — it is consumed
 * by the browser bundles. So it throws a token and this translates it once.
 */
function assertProductInput(input: ProductInput): void {
  try {
    validateProductInput(input);
  } catch (error) {
    if (error instanceof ProductValidationError) throw new ValidationError(error.messageKey);
    throw error;
  }
}

export async function createProduct(input: ProductInput, actor: ActorContext): Promise<Product> {
  requirePermission(actor, 'products.create');

  const name = input.name?.trim();
  if (!name) throw new ValidationError('validation.product.nameRequired');

  if (!input.categoryId && !input.categoryName?.trim()) {
    throw new ValidationError('validation.product.categoryRequired');
  }

  // Every product has at least one variant: the one that carries its code.
  const variants = input.variants ?? [];
  const hasVariants = resolveHasVariants(input, null);

  // The closed sets and ranges — and the variant set — checked before the
  // database gets to. The same function runs on the offline merge path,
  // where a CHECK violation would be recorded as a permanent rejection and
  // replayed forever.
  assertProductInput({ ...input, variants, hasVariants });
  await assertCodesFree(actor.tenantId, variants, null);

  const product = await db().transaction(async (trx) => {
    const hlc = await nextHlc(trx);
    return productRepo.insertProduct(
      {
        tenantId: actor.tenantId,
        // Two permissioned prices, two independent gates. `products.create`
        // says you may add a product; `field.saleRate.edit` says you may price
        // it; `field.purchaseRate.edit` says you may record what it cost.
        // Without one, that value falls back to the catalogue default rather
        // than to whatever the caller sent.
        input: withPermittedPurchaseRate(
          withPermittedRate({ ...input, name, variants, hasVariants }, canEditRates(actor)),
          canEditCost(actor),
        ),
        hlc,
        fieldHlc: {},
        temporaryId: null,
      },
      trx,
    );
  });

  await activityLog.recordDetachedActivity(
    {
      tenantId: actor.tenantId,
      entityType: 'product',
      entityId: product.id,
      action: 'created',
      actorType: actor.actorType,
      actorId: actor.actorId,
      details: { name: product.name },
    },
    actor,
    db(),
  );
  publishChange({ entity: 'product', action: 'created', id: product.id, payload: product });

  return maskProduct(product, productVisibility(actor));
}

export async function updateProduct(
  id: string,
  input: ProductInput,
  actor: ActorContext,
): Promise<Product> {
  requirePermission(actor, 'products.edit');

  const name = input.name?.trim();
  if (!name) throw new ValidationError('validation.product.nameRequired');

  // Read first so the write below can *merge* field_hlc rather than replace
  // it wholesale — see the identical comment on `updateParty`. Without this,
  // an offline edit to any field replayed after this write would silently
  // overwrite it with no conflict ever recorded.
  const existing = await productRepo.findProductById(actor.tenantId, id);
  if (!existing) throw new NotFoundError('Product');

  // The variant set is validated against what the form said about variants,
  // or against what the product already is when the form said nothing. A
  // form that flips the switch off keeps one code; one that flips it on
  // labels every row — `validateProductVariants` holds the rule.
  const hasVariants = resolveHasVariants(input, existing.hasVariants);
  const variants =
    input.variants === undefined
      ? undefined
      : input.variants.map((variant) => ({
          // The entity shape comes back through PATCH-style callers (the
          // public API merges the stored product over the patch); only the
          // input's fields travel on.
          ...(variant.id ? { id: variant.id } : {}),
          code: variant.code,
          label: variant.label ?? null,
          weightKg: variant.weightKg ?? null,
          ...(variant.sequence !== undefined ? { sequence: variant.sequence } : {}),
        }));

  assertProductInput({ ...input, hasVariants, ...(variants ? { variants } : {}) });
  if (variants) await assertCodesFree(actor.tenantId, variants, id);

  const permitted = withPermittedPurchaseRate(
    withPermittedRate(
      { ...input, name, hasVariants, ...(variants ? { variants } : {}) },
      canEditRates(actor),
    ),
    canEditCost(actor),
  );
  const touchedColumns = Object.keys(columnPatch(permitted, PRODUCT_COLUMNS));

  const product = await db().transaction(async (trx) => {
    const hlc = await nextHlc(trx);
    const fieldHlc = { ...existing.sync.fieldHlc };
    for (const column of touchedColumns) fieldHlc[fieldFor(PRODUCT_COLUMNS, column)] = hlc;
    // The variant set is one field to the merge, replaced whole, never
    // merged row by row — so it carries one stamp.
    if (variants) fieldHlc.variants = hlc;

    return productRepo.updateProduct(actor.tenantId, id, permitted, { hlc, fieldHlc }, trx);
  });

  if (!product) throw new NotFoundError('Product');

  await activityLog.recordDetachedActivity(
    {
      tenantId: actor.tenantId,
      entityType: 'product',
      entityId: product.id,
      action: 'updated',
      actorType: actor.actorType,
      actorId: actor.actorId,
      details: { name: product.name },
    },
    actor,
    db(),
  );
  publishChange({ entity: 'product', action: 'updated', id: product.id, payload: product });

  return maskProduct(product, productVisibility(actor));
}

/**
 * Refused while a live line item still quotes this product, or while any
 * colour has non-zero on-hand or reserved stock — on-hand boxes are physical
 * goods in a warehouse, and a catalogue entry can be wrong but the pallet is
 * not.
 */
export async function deleteProduct(
  id: string,
  actor: ActorContext,
): Promise<{ id: string; deletedAt: string }> {
  requirePermission(actor, 'products.delete');

  const existing = await productRepo.findProductById(actor.tenantId, id);
  if (!existing) throw new NotFoundError('Product');

  const blockers = await productRepo.liveReferencesToProduct(actor.tenantId, id);
  if (blockers.length > 0) {
    throw new ConflictError(
      'error.conflict.blockedByLiveReferences',
      {},
      {
        blockedBy: blockers.map((b): BinBlocker => {
          const reason = b.entityType === 'line_item' ? 'live_reference' : 'stock_on_hand';
          return { entityType: b.entityType, id: b.id, label: b.label, reason };
        }),
      },
    );
  }

  const product = await db().transaction(async (trx) => {
    const hlc = await nextHlc(trx);
    const fieldHlc = { ...existing.sync.fieldHlc, deletedAt: hlc };
    const row = await productRepo.softDeleteProduct(
      actor.tenantId,
      id,
      actorUserId(actor),
      { hlc, fieldHlc },
      trx,
    );
    // The variants follow the product into the bin, which is what frees
    // their codes for another product (the partial unique index).
    await productVariantRepo.setDeletedAt(actor.tenantId, id, 'now', trx);

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'product',
        entityId: id,
        action: 'deleted',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { name: existing.name },
      },
      actor,
      trx,
    );

    return row;
  });

  if (!product) throw new NotFoundError('Product');

  publishChange({ entity: 'product', action: 'deleted', id, payload: product });
  return { id: product.id, deletedAt: product.updatedAt };
}

/**
 * Restoring a product brings its variants — and their codes — back. A code
 * another product has taken in the meantime cannot be handed back, and a
 * product's codes are not something to rename on the way out of the bin
 * (they are what the trade quotes), so the restore is refused and names the
 * codes; the administrator moves them off the other product first.
 */
export async function restoreProduct(id: string, actor: ActorContext): Promise<BinRestoreResult> {
  requirePermission(actor, 'products.delete');

  const existing = await productRepo.findProductById(actor.tenantId, id, db(), {
    includeDeleted: true,
  });
  if (!existing) throw new NotFoundError('Product');

  const taken = await productVariantRepo.codesTakenElsewhere(actor.tenantId, id);
  if (taken.length > 0) {
    throw new ConflictError(
      'validation.product.restoreCodesTaken',
      { codes: taken.join(', ') },
      { field: 'code', codes: taken },
    );
  }

  const product = await db().transaction(async (trx) => {
    const hlc = await nextHlc(trx);
    const fieldHlc = { ...existing.sync.fieldHlc, deletedAt: hlc };
    const row = await productRepo.restoreProduct(actor.tenantId, id, { hlc, fieldHlc }, trx);
    await productVariantRepo.setDeletedAt(actor.tenantId, id, null, trx);

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'product',
        entityId: id,
        action: 'restored',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { name: existing.name },
      },
      actor,
      trx,
    );

    return row;
  });

  if (!product) throw new NotFoundError('Product');

  publishChange({ entity: 'product', action: 'restored', id, payload: product });
  return { entityType: 'product', id, renamedTo: undefined, alsoRestored: [] };
}

// --- Party-specific variants ----------------------------------------------

export async function listVariantsForParty(
  partyId: string,
  actor: ActorContext,
): Promise<PartyProductVariant[]> {
  requirePermission(actor, 'parties.view');
  // A party variant is a negotiated price for one party, so it is exactly as
  // private as the party it belongs to.
  await requirePartyAccess(partyId, 'view', actor);

  const variants = await variantRepo.listForParty(actor.tenantId, partyId);
  const allowed = canSeeRates(actor);
  return variants.map((variant) => maskVariant(variant, allowed));
}

export async function upsertVariant(
  input: PartyProductVariantInput,
  actor: ActorContext,
): Promise<PartyProductVariant> {
  requirePermission(actor, 'parties.edit');

  if (!(await partyRepo.findPartyById(actor.tenantId, input.partyId))) {
    throw new NotFoundError('Party');
  }
  await requirePartyAccess(input.partyId, 'manage', actor);
  if (!(await productRepo.findProductById(actor.tenantId, input.productId))) {
    throw new NotFoundError('Product');
  }

  const variant = await db().transaction(async (trx) => {
    const hlc = await nextHlc(trx);
    // A party variant is, in practice, mostly a negotiated price. Letting it
    // through unguarded would make the whole permission avoidable by pricing
    // the product per-party instead.
    return variantRepo.upsertVariant(
      { tenantId: actor.tenantId, hlc },
      withPermittedRate(input, canEditRates(actor)),
      trx,
    );
  });

  publishChange({
    entity: 'party_variant',
    action: 'updated',
    id: variant.id,
    payload: variant,
  });

  return maskVariant(variant, canSeeRates(actor));
}

export async function countParties(actor: ActorContext): Promise<number> {
  return partyRepo.countParties(actor.tenantId, resolvePartyScope(actor));
}

export async function countProducts(tenantId: string): Promise<number> {
  return productRepo.countProducts(tenantId);
}
