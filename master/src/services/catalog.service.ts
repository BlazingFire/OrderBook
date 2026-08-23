/**
 * Parties, products and party-specific variants — the master data leads are
 * built from. Validation, permissions and change publication live here; SQL
 * lives in the repositories.
 */

import type {
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
import { canSeeRates, maskProduct, maskVariant } from '../domain/visibility.js';
import { db } from '../db/knex.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import * as activityLog from '../repositories/activity-log.repository.js';
import { nextHlc } from '../repositories/identity.repository.js';
import * as partyRepo from '../repositories/party.repository.js';
import * as variantRepo from '../repositories/party-variant.repository.js';
import * as productRepo from '../repositories/product.repository.js';
import { publishChange } from './change-bus.js';

const PAGING = { defaultLimit: 100, maxLimit: 500 };

// --- Parties ---------------------------------------------------------------

export async function listParties(
  query: { search?: string; limit?: number; offset?: number },
  actor: ActorContext,
): Promise<Paginated<Party>> {
  requirePermission(actor, 'parties.view');
  return partyRepo.listParties(actor.tenantId, {
    search: query.search,
    ...clampPaging(query, PAGING),
  });
}

export async function createParty(input: PartyInput, actor: ActorContext): Promise<Party> {
  requirePermission(actor, 'parties.create');

  const name = input.name?.trim();
  if (!name) throw new ValidationError('Party name is required');

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

  await activityLog.recordActivity({
    tenantId: actor.tenantId,
    entityType: 'party',
    entityId: party.id,
    action: 'created',
    actorType: actor.actorType,
    actorId: actor.actorId,
  });
  publishChange({ entity: 'party', action: 'created', id: party.id, payload: party });

  return party;
}

export async function updateParty(
  id: string,
  input: PartyInput,
  actor: ActorContext,
): Promise<Party> {
  requirePermission(actor, 'parties.edit');

  const name = input.name?.trim();
  if (!name) throw new ValidationError('Party name is required');

  const party = await db().transaction(async (trx) => {
    const hlc = await nextHlc(trx);
    return partyRepo.updateParty(actor.tenantId, id, { ...input, name }, { hlc, fieldHlc: {} }, trx);
  });

  if (!party) throw new NotFoundError('Party');

  await activityLog.recordActivity({
    tenantId: actor.tenantId,
    entityType: 'party',
    entityId: party.id,
    action: 'updated',
    actorType: actor.actorType,
    actorId: actor.actorId,
  });
  publishChange({ entity: 'party', action: 'updated', id: party.id, payload: party });

  return party;
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
  if (!name) throw new ValidationError('Product name is required');

  // Staff who do not have a code to hand get one generated rather than being
  // blocked on inventing one at the counter.
  const productCode = input.productCode?.trim() || (await productRepo.nextProductCode());

  if (await productRepo.findProductByCode(actor.tenantId, productCode)) {
    throw new ConflictError(`Product code "${productCode}" is already in use`);
  }

  const product = await db().transaction(async (trx) => {
    const hlc = await nextHlc(trx);
    return productRepo.insertProduct(
      {
        tenantId: actor.tenantId,
        input: { ...input, name, productCode },
        hlc,
        fieldHlc: {},
        temporaryId: null,
      },
      trx,
    );
  });

  await activityLog.recordActivity({
    tenantId: actor.tenantId,
    entityType: 'product',
    entityId: product.id,
    action: 'created',
    actorType: actor.actorType,
    actorId: actor.actorId,
  });
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
  if (!name) throw new ValidationError('Product name is required');

  const productCode = input.productCode?.trim();
  if (!productCode) throw new ValidationError('Product code is required');

  const clashing = await productRepo.findProductByCode(actor.tenantId, productCode);
  if (clashing && clashing.id !== id) {
    throw new ConflictError(`Product code "${productCode}" is already in use`);
  }

  const product = await db().transaction(async (trx) => {
    const hlc = await nextHlc(trx);
    return productRepo.updateProduct(
      actor.tenantId,
      id,
      { ...input, name, productCode },
      { hlc, fieldHlc: {} },
      trx,
    );
  });

  if (!product) throw new NotFoundError('Product');

  await activityLog.recordActivity({
    tenantId: actor.tenantId,
    entityType: 'product',
    entityId: product.id,
    action: 'updated',
    actorType: actor.actorType,
    actorId: actor.actorId,
  });
  publishChange({ entity: 'product', action: 'updated', id: product.id, payload: product });

  return maskProduct(product, canSeeRates(actor));
}

// --- Party-specific variants ----------------------------------------------

export async function listVariantsForParty(
  partyId: string,
  actor: ActorContext,
): Promise<PartyProductVariant[]> {
  requirePermission(actor, 'parties.view');

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
  if (!(await productRepo.findProductById(actor.tenantId, input.productId))) {
    throw new NotFoundError('Product');
  }

  const variant = await db().transaction(async (trx) => {
    const hlc = await nextHlc(trx);
    return variantRepo.upsertVariant({ tenantId: actor.tenantId, hlc }, input, trx);
  });

  publishChange({
    entity: 'party_variant',
    action: 'updated',
    id: variant.id,
    payload: variant,
  });

  return maskVariant(variant, canSeeRates(actor));
}

export async function countParties(tenantId: string): Promise<number> {
  return partyRepo.countParties(tenantId);
}

export async function countProducts(tenantId: string): Promise<number> {
  return productRepo.countProducts(tenantId);
}
