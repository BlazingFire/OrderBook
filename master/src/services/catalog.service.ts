/**
 * Parties and products — the master data leads are built from. Validation and
 * change publication live here; SQL lives in the repositories.
 */

import type {
  Paginated,
  Party,
  PartyInput,
  Product,
  ProductCategory,
  ProductInput,
} from '@orderbook/shared';

import type { ActorContext } from '../domain/actor.js';
import { clampPaging } from '../domain/paging.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import * as activityLog from '../repositories/activity-log.repository.js';
import * as partyRepo from '../repositories/party.repository.js';
import * as productRepo from '../repositories/product.repository.js';
import { publishChange } from './change-bus.js';

const PAGING = { defaultLimit: 100, maxLimit: 500 };

// --- Parties ---

export async function listParties(query: {
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<Paginated<Party>> {
  return partyRepo.listParties({ search: query.search, ...clampPaging(query, PAGING) });
}

export async function createParty(input: PartyInput, actor: ActorContext): Promise<Party> {
  const name = input.name?.trim();
  if (!name) throw new ValidationError('Party name is required');

  const party = await partyRepo.insertParty({ ...input, name }, null);

  await activityLog.recordActivity({
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
  const name = input.name?.trim();
  if (!name) throw new ValidationError('Party name is required');

  const party = await partyRepo.updateParty(id, { ...input, name });
  if (!party) throw new NotFoundError('Party');

  await activityLog.recordActivity({
    entityType: 'party',
    entityId: party.id,
    action: 'updated',
    actorType: actor.actorType,
    actorId: actor.actorId,
  });
  publishChange({ entity: 'party', action: 'updated', id: party.id, payload: party });

  return party;
}

// --- Products ---

export async function listProducts(query: {
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<Paginated<Product>> {
  return productRepo.listProducts({ search: query.search, ...clampPaging(query, PAGING) });
}

export async function listCategories(): Promise<ProductCategory[]> {
  return productRepo.listCategories();
}

export async function createProduct(input: ProductInput, actor: ActorContext): Promise<Product> {
  const name = input.name?.trim();
  if (!name) throw new ValidationError('Product name is required');

  // Staff who do not have a code to hand get one generated rather than being
  // blocked on inventing one at the counter.
  const productCode = input.productCode?.trim() || (await productRepo.nextProductCode());

  if (await productRepo.findProductByCode(productCode)) {
    throw new ConflictError(`Product code "${productCode}" is already in use`);
  }

  const product = await productRepo.insertProduct({ ...input, name, productCode });

  await activityLog.recordActivity({
    entityType: 'product',
    entityId: product.id,
    action: 'created',
    actorType: actor.actorType,
    actorId: actor.actorId,
  });
  publishChange({ entity: 'product', action: 'created', id: product.id, payload: product });

  return product;
}

export async function updateProduct(
  id: string,
  input: ProductInput,
  actor: ActorContext,
): Promise<Product> {
  const name = input.name?.trim();
  if (!name) throw new ValidationError('Product name is required');

  const productCode = input.productCode?.trim();
  if (!productCode) throw new ValidationError('Product code is required');

  const clashing = await productRepo.findProductByCode(productCode);
  if (clashing && clashing.id !== id) {
    throw new ConflictError(`Product code "${productCode}" is already in use`);
  }

  const product = await productRepo.updateProduct(id, { ...input, name, productCode });
  if (!product) throw new NotFoundError('Product');

  await activityLog.recordActivity({
    entityType: 'product',
    entityId: product.id,
    action: 'updated',
    actorType: actor.actorType,
    actorId: actor.actorId,
  });
  publishChange({ entity: 'product', action: 'updated', id: product.id, payload: product });

  return product;
}
