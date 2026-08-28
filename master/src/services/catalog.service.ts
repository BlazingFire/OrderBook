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
} from '@orderbook/shared';

import { actorUserId, requirePermission, type ActorContext } from '../domain/actor.js';
import { clampPaging } from '../domain/paging.js';
import { resolvePartyScope } from '../domain/party-scope.js';
import { suggestRestoredName } from '../domain/recycle-bin.js';
import {
  canEditRates,
  canSeeRates,
  maskProduct,
  maskVariant,
  withPermittedRate,
} from '../domain/visibility.js';
import { db } from '../db/knex.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import * as activityLog from '../repositories/activity-log.repository.js';
import { nextHlc } from '../repositories/identity.repository.js';
import * as partyRepo from '../repositories/party.repository.js';
import * as variantRepo from '../repositories/party-variant.repository.js';
import * as productRepo from '../repositories/product.repository.js';
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

  await activityLog.recordDetachedActivity({
    tenantId: actor.tenantId,
    entityType: 'party',
    entityId: party.id,
    action: 'created',
    actorType: actor.actorType,
    actorId: actor.actorId,
  }, actor, db());
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

  const party = await db().transaction(async (trx) => {
    const hlc = await nextHlc(trx);
    return partyRepo.updateParty(actor.tenantId, id, { ...input, name }, { hlc, fieldHlc: {} }, trx);
  });

  if (!party) throw new NotFoundError('Party');

  await activityLog.recordDetachedActivity({
    tenantId: actor.tenantId,
    entityType: 'party',
    entityId: party.id,
    action: 'updated',
    actorType: actor.actorType,
    actorId: actor.actorId,
  }, actor, db());
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
    throw new ConflictError('error.conflict.blockedByLiveReferences', {}, {
      blockedBy: blockers.map(
        (b): BinBlocker => ({ entityType: b.entityType, id: b.id, label: b.label, reason: 'live_reference' }),
      ),
    });
  }

  const party = await db().transaction(async (trx) => {
    const hlc = await nextHlc(trx);
    const fieldHlc = { ...existing.sync.fieldHlc, deletedAt: hlc };
    const row = await partyRepo.softDeleteParty(actor.tenantId, id, actorUserId(actor), { hlc, fieldHlc }, trx);

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

  const existing = await partyRepo.findPartyById(actor.tenantId, id, db(), { includeDeleted: true });
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
    const row = await partyRepo.restoreParty(
      actor.tenantId,
      id,
      { hlc, fieldHlc },
      trx,
      renameTo,
    );

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
  query: { search?: string; limit?: number; offset?: number },
  actor: ActorContext,
): Promise<Paginated<Product>> {
  requirePermission(actor, 'products.view');

  const page = await productRepo.listProducts(actor.tenantId, {
    search: query.search,
    ...clampPaging(query, PAGING),
  });

  const allowed = canSeeRates(actor);
  return { ...page, items: page.items.map((product) => maskProduct(product, allowed)) };
}

export async function listCategories(actor: ActorContext): Promise<ProductCategory[]> {
  requirePermission(actor, 'products.view');
  return productRepo.listCategories(actor.tenantId);
}

/** Backs the "type a code and the line fills itself" input (§3.2). */
export async function findProductByCode(
  code: string,
  actor: ActorContext,
): Promise<Product | null> {
  requirePermission(actor, 'products.view');

  const product = await productRepo.findProductByCode(actor.tenantId, code);
  return product ? maskProduct(product, canSeeRates(actor)) : null;
}

export async function createProduct(
  input: ProductInput,
  actor: ActorContext,
): Promise<Product> {
  requirePermission(actor, 'products.create');

  const name = input.name?.trim();
  if (!name) throw new ValidationError('validation.product.nameRequired');

  // Staff who do not have a code to hand get one generated rather than being
  // blocked on inventing one at the counter.
  const productCode = input.productCode?.trim() || (await productRepo.nextProductCode());

  if (await productRepo.findProductByCode(actor.tenantId, productCode)) {
    throw new ConflictError('error.conflict.productCodeTaken', { productCode });
  }

  const product = await db().transaction(async (trx) => {
    const hlc = await nextHlc(trx);
    return productRepo.insertProduct(
      {
        tenantId: actor.tenantId,
        // The rate is a permissioned field in its own right: `products.create`
        // says you may add a product, `field.saleRate.edit` says you may price
        // it. Without the second, the rate falls back to whatever the catalogue
        // default is rather than to what the caller asked for.
        input: withPermittedRate({ ...input, name, productCode }, canEditRates(actor)),
        hlc,
        fieldHlc: {},
        temporaryId: null,
      },
      trx,
    );
  });

  await activityLog.recordDetachedActivity({
    tenantId: actor.tenantId,
    entityType: 'product',
    entityId: product.id,
    action: 'created',
    actorType: actor.actorType,
    actorId: actor.actorId,
  }, actor, db());
  publishChange({ entity: 'product', action: 'created', id: product.id, payload: product });

  return maskProduct(product, canSeeRates(actor));
}

export async function updateProduct(
  id: string,
  input: ProductInput,
  actor: ActorContext,
): Promise<Product> {
  requirePermission(actor, 'products.edit');

  const name = input.name?.trim();
  if (!name) throw new ValidationError('validation.product.nameRequired');

  const productCode = input.productCode?.trim();
  if (!productCode) throw new ValidationError('validation.product.codeRequired');

  const clashing = await productRepo.findProductByCode(actor.tenantId, productCode);
  if (clashing && clashing.id !== id) {
    throw new ConflictError('error.conflict.productCodeTaken', { productCode });
  }

  const product = await db().transaction(async (trx) => {
    const hlc = await nextHlc(trx);
    return productRepo.updateProduct(
      actor.tenantId,
      id,
      withPermittedRate({ ...input, name, productCode }, canEditRates(actor)),
      { hlc, fieldHlc: {} },
      trx,
    );
  });

  if (!product) throw new NotFoundError('Product');

  await activityLog.recordDetachedActivity({
    tenantId: actor.tenantId,
    entityType: 'product',
    entityId: product.id,
    action: 'updated',
    actorType: actor.actorType,
    actorId: actor.actorId,
  }, actor, db());
  publishChange({ entity: 'product', action: 'updated', id: product.id, payload: product });

  return maskProduct(product, canSeeRates(actor));
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
    throw new ConflictError('error.conflict.blockedByLiveReferences', {}, {
      blockedBy: blockers.map((b): BinBlocker => {
        const reason = b.entityType === 'line_item' ? 'live_reference' : 'stock_on_hand';
        return { entityType: b.entityType, id: b.id, label: b.label, reason };
      }),
    });
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

export async function restoreProduct(
  id: string,
  actor: ActorContext,
  renameTo: string | undefined,
): Promise<BinRestoreResult> {
  requirePermission(actor, 'products.delete');

  const existing = await productRepo.findProductById(actor.tenantId, id, db(), { includeDeleted: true });
  if (!existing) throw new NotFoundError('Product');

  const desiredCode = renameTo ?? existing.productCode;
  const clashing = await productRepo.findProductByCode(actor.tenantId, desiredCode);
  if (clashing && clashing.id !== id) {
    const suggestion = await suggestRestoredName(existing.productCode, async (candidate) => {
      const row = await productRepo.findProductByCode(actor.tenantId, candidate);
      return row !== null && row.id !== id;
    });
    throw new ConflictError(
      'error.conflict.restoreCollision',
      { field: 'productCode' },
      { field: 'productCode', value: desiredCode, suggestion },
    );
  }

  const product = await db().transaction(async (trx) => {
    const hlc = await nextHlc(trx);
    const fieldHlc = { ...existing.sync.fieldHlc, deletedAt: hlc };
    const row = await productRepo.restoreProduct(actor.tenantId, id, { hlc, fieldHlc }, trx, renameTo);

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'product',
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

  if (!product) throw new NotFoundError('Product');

  publishChange({ entity: 'product', action: 'restored', id, payload: product });
  return { entityType: 'product', id, renamedTo: renameTo, alsoRestored: [] };
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
