/**
 * Parties, products and party-specific variants — the master data leads are
 * built from. Validation, permissions and change publication live here; SQL
 * lives in the repositories.
 */

import type {
  BinBlocker,
  BinRestoreResult,
  CategoryInput,
  CategoryUpdateInput,
  PartyListQuery,
  Paginated,
  Party,
  PartyAccessLevel,
  PartyInput,
  PartyProductVariant,
  PartyProductVariantInput,
  Product,
  ProductCategory,
  ProductCategoryListRow,
  ProductInput,
  ProductListPage,
  ProductListQuery,
  ProductVariantInput,
} from '@orderbook/shared';
import {
  CATEGORY_CODE_PATTERN,
  columnPatch,
  fieldFor,
  PARTY_COLUMNS,
  PRODUCT_COLUMNS,
  ProductValidationError,
  validateProductInput,
} from '@orderbook/shared';

import { actorCan, actorUserId, requirePermission, type ActorContext } from '../domain/actor.js';
import { clampPaging } from '../domain/paging.js';
import { creatorGrantee, resolvePartyScope } from '../domain/party-scope.js';
import { assertParentsLive, suggestRestoredName } from '../domain/recycle-bin.js';
import { db } from '../db/knex.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import { seqCached } from '../lib/seq-cache.js';
import * as activityLog from '../repositories/activity-log.repository.js';
import * as customFieldRepo from '../repositories/custom-field.repository.js';
import { nextHlc } from '../repositories/identity.repository.js';
import * as partyAccessRepo from '../repositories/party-access.repository.js';
import * as partyRepo from '../repositories/party.repository.js';
import * as variantRepo from '../repositories/party-variant.repository.js';
import * as productRepo from '../repositories/product.repository.js';
import * as productVariantRepo from '../repositories/product-variant.repository.js';
import type { TransactionContext } from '../repositories/transaction.js';
import { publishChange } from './change-bus.js';
import { requirePartyAccess } from './party-access.service.js';

const PAGING = { defaultLimit: 100, maxLimit: 500 };

/**
 * The catalogue's own ceiling, above the parties' and leads': the snapshot
 * asks for every sub product at once (`snapshot.service.ts`), and the SWISWARE
 * catalogue alone is 549 of them — at 500 the panel's offline catalogue, and
 * its sub-product bar, silently lost the tail.
 */
export const PRODUCT_PAGING = { defaultLimit: 100, maxLimit: 2000 };

// --- Parties ---------------------------------------------------------------

export async function listParties(
  query: PartyListQuery,
  actor: ActorContext,
): Promise<Paginated<Party>> {
  requirePermission(actor, 'parties.view');
  return partyRepo.listParties(actor.tenantId, {
    search: query.search,
    ...clampPaging(query, PAGING),
    scope: resolvePartyScope(actor),
    filter: query.scope,
    sort: typeof query.sort === 'string' ? query.sort : undefined,
    dir: query.dir === 'desc' ? 'desc' : 'asc',
    city: typeof query.city === 'string' ? query.city : undefined,
    state: typeof query.state === 'string' ? query.state : undefined,
    hasGst: typeof query.hasGst === 'boolean' ? query.hasGst : undefined,
  });
}

/**
 * One party, party-scoped.
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
    const row = await partyRepo.insertParty(
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

    // Private from its first instant: the creator's own grant lands with the party, in this
    // transaction, so no reader ever sees an open party that was meant to be theirs alone. Every path
    // that creates a party (HTTP, socket, the Office outbox, the connector) comes through here.
    const owner = creatorGrantee(actor);
    if (owner) await partyAccessRepo.grantCreator(actor.tenantId, row.id, owner, trx);

    // In the transaction and last in it (`activity-log.repository.ts`): the
    // entry used to be written after the commit, on another connection, by a
    // function that swallows its own failure — so a party could be saved with
    // no entry at all.
    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'party',
        entityId: row.id,
        action: 'created',
        actorType: actor.actorType,
        actorId: actor.actorId,
        // The catalogue's tokens read "{actor} added the party {name}", so an entry
        // without a name renders the placeholder to the reader. The delete and
        // restore paths always carried one; create and update did not, and the
        // Activity log showed a literal `{name}` on every one of them.
        details: { name: row.name },
      },
      actor,
      trx,
    );

    return row;
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

    const row = await partyRepo.updateParty(actor.tenantId, id, merged, { hlc, fieldHlc }, trx);
    if (!row) throw new NotFoundError('Party');

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'party',
        entityId: row.id,
        action: 'updated',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { name: row.name },
      },
      actor,
      trx,
    );

    return row;
  });

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
    brand: typeof query.brand === 'string' ? query.brand : undefined,
    missingWeight: query.missingWeight,
    sort: typeof query.sort === 'string' ? query.sort : undefined,
    dir: query.dir === 'desc' ? 'desc' : 'asc',
    size: typeof query.size === 'string' ? query.size : undefined,
    hasPhoto: typeof query.hasPhoto === 'boolean' ? query.hasPhoto : undefined,
    ...clampPaging(query, PRODUCT_PAGING),
  });

  return page;
}

export async function getProduct(id: string, actor: ActorContext): Promise<Product> {
  requirePermission(actor, 'products.view');

  const product = await productRepo.findProductById(actor.tenantId, id);
  if (!product) throw new NotFoundError('Product');

  return product;
}

/** Live categories — the owner's Products — in catalogue order, each with its sub-product count. */
export async function listCategories(
  actor: ActorContext,
  query: { search?: string; brand?: string } = {},
): Promise<ProductCategoryListRow[]> {
  requirePermission(actor, 'products.view');
  // Read on every panel reconnect and every Products open; any change drops it (`lib/seq-cache.ts`).
  const key = JSON.stringify(query ?? {});
  if (key.length > 200) return readCategories(actor, query);
  return seqCached(`categories:${actor.tenantId}:${key}`, 10_000, () => readCategories(actor, query));
}

async function readCategories(
  actor: ActorContext,
  query: { search?: string; brand?: string } = {},
): Promise<ProductCategoryListRow[]> {
  requirePermission(actor, 'products.view');
  // Typed on the way in: a socket payload is whatever the panel sent.
  return productRepo.listCategories(actor.tenantId, db(), {
    search: typeof query?.search === 'string' ? query.search : undefined,
    brand: typeof query?.brand === 'string' ? query.brand : undefined,
  });
}

/** The product behind a variant code — the "type a code" lookup, by variant now. */
export async function findProductByCode(
  code: string,
  actor: ActorContext,
): Promise<Product | null> {
  requirePermission(actor, 'products.view');

  const variant = await productVariantRepo.findVariantByCode(actor.tenantId, code);
  if (!variant) return null;
  return productRepo.findProductById(actor.tenantId, variant.productId);
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

/** `One Piece Toilet` — how the log and a refusal name a sub product's product (never its code). */
function categoryLabel(product: Pick<Product, 'categoryName'>): string {
  return product.categoryName;
}

/**
 * A blank variant code becomes the next `CODE-####` of the product it goes
 * into (`docs/catalogue/CATALOGUE_MODEL.md` §5), so staff adding a sub
 * product need not invent one. Only a product named by id or code has a code
 * to number from; anything else keeps its blank, which the validator refuses.
 *
 * ponytail: read-then-write, so two people adding a sub product to one
 * product in the same instant draw the same number and the second gets
 * `productCodeTaken` from the unique index — a retry, not a corruption.
 */
async function fillBlankCodes(
  tenantId: string,
  category: { categoryId?: string | null; categoryCode?: string | null },
  variants: readonly ProductVariantInput[],
): Promise<ProductVariantInput[]> {
  const blanks = variants.filter((variant) => !variant.code?.trim()).length;
  if (blanks === 0) return [...variants];

  const code = category.categoryId
    ? (await productRepo.findCategoryById(tenantId, category.categoryId))?.code
    : category.categoryCode?.trim()
      ? (await productRepo.findLiveCategoryByCode(tenantId, category.categoryCode))?.code
      : null;
  if (!code) return [...variants];

  const codes = await productRepo.nextSubProductCodes(tenantId, code, blanks);
  return variants.map((variant) =>
    variant.code?.trim() ? variant : { ...variant, code: codes.shift() as string },
  );
}

/**
 * Sub-product names are unique inside their product among live rows (§5).
 * Checked on the row as written, inside the write's transaction, so a
 * refusal rolls the write back and the category is the one actually resolved.
 * Exported for the offline merge in `sync.service.ts`, which writes around
 * this service.
 */
export async function assertSubProductNameFree(
  tenantId: string,
  row: Product,
  trx: TransactionContext,
): Promise<void> {
  if (await productRepo.findLiveSubProductByName(tenantId, row.categoryId, row.name, row.id, trx)) {
    throw new ConflictError('validation.product.nameTaken', {
      name: row.name,
      category: categoryLabel(row),
    });
  }
}

/** What the log shows of a sub product: the fields staff edit, the category by label, never an id. */
function loggedProduct(product: Product): Record<string, unknown> {
  return {
    name: product.name,
    product: categoryLabel(product),
    alias: product.alias,
    size: product.size,
    multiColour: product.multiColour,
    sortOrder: product.sortOrder,
    variants: product.variants
      .filter((variant) => variant.isActive)
      .map((variant) =>
        [variant.code, variant.label, variant.weightKg].filter((part) => part !== null).join(' '),
      )
      .join(', '),
  };
}

/** `{field: {from, to}}` for each logged field whose value actually moved. */
function productChanges(
  before: Product,
  after: Product,
): Record<string, { from: unknown; to: unknown }> {
  const from = loggedProduct(before);
  const to = loggedProduct(after);
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const field of Object.keys(to)) {
    if (JSON.stringify(from[field] ?? null) !== JSON.stringify(to[field] ?? null)) {
      changes[field] = { from: from[field] ?? null, to: to[field] ?? null };
    }
  }
  return changes;
}

export async function createProduct(input: ProductInput, actor: ActorContext): Promise<Product> {
  requirePermission(actor, 'products.create');

  const name = input.name?.trim();
  if (!name) throw new ValidationError('validation.product.nameRequired');

  if (!input.categoryId && !input.categoryCode?.trim() && !input.categoryName?.trim()) {
    throw new ValidationError('validation.product.categoryRequired');
  }

  // Every product has at least one variant: the one that carries its code.
  const variants = await fillBlankCodes(actor.tenantId, input, input.variants ?? []);
  const hasVariants = resolveHasVariants(input, null);

  // The closed sets and ranges — and the variant set — checked before the
  // database gets to. The same function runs on the offline merge path,
  // where a CHECK violation would be recorded as a permanent rejection and
  // replayed forever.
  assertProductInput({ ...input, variants, hasVariants });
  await assertCodesFree(actor.tenantId, variants, null);

  const product = await db().transaction(async (trx) => {
    const hlc = await nextHlc(trx);
    const row = await productRepo.insertProduct(
      {
        tenantId: actor.tenantId,
        input: { ...input, name, variants, hasVariants },
        hlc,
        fieldHlc: {},
        temporaryId: null,
      },
      trx,
    );
    await assertSubProductNameFree(actor.tenantId, row, trx);

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'product',
        entityId: row.id,
        action: 'created',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { name: row.name, product: categoryLabel(row) },
      },
      actor,
      trx,
    );

    return row;
  });

  publishChange({ entity: 'product', action: 'created', id: product.id, payload: product });

  return product;
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
  const movesCategory =
    input.categoryId !== undefined ||
    input.categoryCode !== undefined ||
    input.categoryName !== undefined;
  const variants =
    input.variants === undefined
      ? undefined
      : await fillBlankCodes(
          actor.tenantId,
          movesCategory ? input : { categoryId: existing.categoryId },
          input.variants.map((variant) => ({
            // The entity shape comes back through PATCH-style callers (the
            // public API merges the stored product over the patch); only the
            // input's fields travel on.
            ...(variant.id ? { id: variant.id } : {}),
            code: variant.code,
            label: variant.label ?? null,
            weightKg: variant.weightKg ?? null,
            ...(variant.sequence !== undefined ? { sequence: variant.sequence } : {}),
          })),
        );

  assertProductInput({ ...input, hasVariants, ...(variants ? { variants } : {}) });
  if (variants) await assertCodesFree(actor.tenantId, variants, id);

  const permitted = { ...input, name, hasVariants, ...(variants ? { variants } : {}) };
  const touchedColumns = Object.keys(columnPatch(permitted, PRODUCT_COLUMNS));

  const product = await db().transaction(async (trx) => {
    const hlc = await nextHlc(trx);
    const fieldHlc = { ...existing.sync.fieldHlc };
    for (const column of touchedColumns) fieldHlc[fieldFor(PRODUCT_COLUMNS, column)] = hlc;
    // The variant set is one field to the merge, replaced whole, never
    // merged row by row — so it carries one stamp.
    if (variants) fieldHlc.variants = hlc;

    const row = await productRepo.updateProduct(actor.tenantId, id, permitted, { hlc, fieldHlc }, trx);
    if (!row) throw new NotFoundError('Product');
    // Only when the name or the product moved: two legacy twins from before
    // the rule must stay editable.
    if (
      row.categoryId !== existing.categoryId ||
      row.name.toLowerCase() !== existing.name.toLowerCase()
    ) {
      await assertSubProductNameFree(actor.tenantId, row, trx);
    }

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'product',
        entityId: row.id,
        action: 'updated',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: {
          name: row.name,
          product: categoryLabel(row),
          changes: productChanges(existing, row),
        },
      },
      actor,
      trx,
    );

    return row;
  });

  publishChange({ entity: 'product', action: 'updated', id: product.id, payload: product });

  return product;
}

/**
 * Refused while a live line item still quotes this product.
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
        blockedBy: blockers.map(
          (b): BinBlocker => ({ entityType: b.entityType, id: b.id, label: b.label, reason: 'live_reference' }),
        ),
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
        details: { name: existing.name, product: categoryLabel(existing) },
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

    // Upward only (`PARENT_LINKS`): a sub product cannot come back into a
    // product that is itself still in the Bin. Read locked, in here: restoring
    // changes no key, so nothing else holds the category, and a
    // `deleteCategory` counting live sub products at this moment would not see
    // this one and bin the product over it.
    const parent = await productRepo.findCategoryById(actor.tenantId, existing.categoryId, trx, {
      includeDeleted: true,
      forUpdate: true,
    });
    if (parent) {
      assertParentsLive([
        {
          entityType: 'product_category',
          id: parent.id,
          label: parent.name,
          isLive: parent.deletedAt === null,
        },
      ]);
    }

    const fieldHlc = { ...existing.sync.fieldHlc, deletedAt: hlc };
    const row = await productRepo.restoreProduct(actor.tenantId, id, { hlc, fieldHlc }, trx);
    await productVariantRepo.setDeletedAt(actor.tenantId, id, null, trx);
    // A sub product of the same name may have been added while this one sat in the Bin.
    if (row) await assertSubProductNameFree(actor.tenantId, row, trx);

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'product',
        entityId: id,
        action: 'restored',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { name: existing.name, product: categoryLabel(existing) },
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

// --- Categories: the owner's Products (`docs/catalogue/CATALOGUE_MODEL.md` §5) --

/**
 * Each asserted field trimmed and checked; absent stays absent. The brand has
 * to be a live `product.brand` value — brands are managed there, and a typed
 * one would be a brand no filter could find. `switchedOffBrand` takes one the
 * list holds switched off too.
 */
async function cleanCategoryInput(
  tenantId: string,
  input: CategoryUpdateInput,
  switchedOffBrand = false,
): Promise<CategoryUpdateInput> {
  const clean: CategoryUpdateInput = {};

  if (input.name !== undefined) {
    const name = String(input.name ?? '').trim();
    if (!name) throw new ValidationError('validation.category.nameRequired');
    clean.name = name;
  }

  if (input.code !== undefined) {
    const code = String(input.code ?? '').trim();
    if (!code) throw new ValidationError('validation.category.codeRequired');
    if (!CATEGORY_CODE_PATTERN.test(code))
      throw new ValidationError('validation.category.codeInvalid');
    clean.code = code;
  }

  if (input.brand !== undefined) {
    const brand = typeof input.brand === 'string' ? input.brand.trim() || null : null;
    if (
      brand &&
      !(await customFieldRepo.isValidOption(tenantId, 'product.brand', brand, {
        includeInactive: switchedOffBrand,
      }))
    ) {
      throw new ValidationError('validation.category.brandUnknown', { brand });
    }
    clean.brand = brand;
  }

  if (input.sortOrder !== undefined) {
    const { sortOrder } = input;
    if (sortOrder !== null && !(Number.isInteger(sortOrder) && (sortOrder as number) >= 0)) {
      throw new ValidationError('validation.category.sortOrder');
    }
    clean.sortOrder = sortOrder;
  }

  return clean;
}

/** What `idx_categories_code` and `idx_categories_brand_name` would refuse, refused by name first. */
async function assertCategoryFree(
  tenantId: string,
  next: { name: string; code: string | null; brand: string | null },
  excludeId: string | null,
): Promise<void> {
  if (next.code) {
    const byCode = await productRepo.findLiveCategoryByCode(tenantId, next.code);
    if (byCode && byCode.id !== excludeId) {
      throw new ConflictError('error.conflict.categoryCodeTaken', { code: next.code });
    }
  }
  const byName = await productRepo.findLiveCategoryByBrandName(tenantId, next.brand, next.name);
  if (byName && byName.id !== excludeId) {
    throw new ConflictError('error.conflict.categoryNameTaken', { name: next.name });
  }
}

/**
 * The same refusal when the check above lost a race: two panels saving one
 * code in the same instant both pass it, and the second write meets the index
 * as a raw `23505` — a 500 to that person — instead of the conflict it is.
 */
function categoryClash(error: unknown, next: { name: string; code: string | null }): unknown {
  const pg = error as { code?: string; constraint?: string } | null;
  if (pg?.code !== '23505') return error;
  if (pg.constraint === 'idx_categories_code') {
    return new ConflictError('error.conflict.categoryCodeTaken', { code: next.code ?? '' });
  }
  if (pg.constraint === 'idx_categories_brand_name') {
    return new ConflictError('error.conflict.categoryNameTaken', { name: next.name });
  }
  return error;
}

async function recordCategoryActivity(
  actor: ActorContext,
  category: ProductCategory,
  action: 'created' | 'updated' | 'deleted' | 'restored',
  trx: TransactionContext,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await activityLog.recordActivity(
    {
      tenantId: actor.tenantId,
      entityType: 'product_category',
      entityId: category.id,
      action,
      actorType: actor.actorType,
      actorId: actor.actorId,
      details: { name: category.name, code: category.code, brand: category.brand, ...extra },
    },
    actor,
    trx,
  );
}

/**
 * The sub products in a panel's snapshot carry their category's name, code
 * and brand joined in, and a `product_category` upsert never touches those
 * rows. So a change to any of the three is announced as a catalogue change
 * too — one event, and every panel refetches its catalogue once.
 */
function publishCatalogueMoved(actor: ActorContext, categoryId: string): void {
  publishChange({
    entity: 'catalog',
    action: 'updated',
    id: actor.tenantId,
    payload: { categoryId },
  });
}

export async function createCategory(
  input: CategoryInput,
  actor: ActorContext,
): Promise<ProductCategory> {
  requirePermission(actor, 'products.create');

  // Name and code are required, so they are asserted even when the body left
  // them out — `cleanCategoryInput` only checks what is asserted.
  const clean = await cleanCategoryInput(actor.tenantId, {
    ...input,
    name: input?.name ?? '',
    code: input?.code ?? '',
  });
  const fields = {
    name: clean.name as string,
    code: clean.code as string,
    brand: clean.brand ?? null,
    sortOrder: clean.sortOrder ?? null,
  };
  await assertCategoryFree(actor.tenantId, fields, null);

  const category = await db()
    .transaction(async (trx) => {
      const row = await productRepo.insertCategory({ tenantId: actor.tenantId, ...fields }, trx);
      await recordCategoryActivity(actor, row, 'created', trx);
      return row;
    })
    .catch((error: unknown) => {
      throw categoryClash(error, fields);
    });

  publishChange({
    entity: 'product_category',
    action: 'created',
    id: category.id,
    payload: category,
  });
  return category;
}

/**
 * A partial edit, logged as `{field: {from, to}}` for what actually moved.
 * `switchedOffBrand` is the product restore's: it puts back the brand a backup
 * had, which the list may hold switched off since.
 */
export async function updateCategory(
  id: string,
  input: CategoryUpdateInput,
  actor: ActorContext,
  { switchedOffBrand = false }: { switchedOffBrand?: boolean } = {},
): Promise<ProductCategory> {
  requirePermission(actor, 'products.edit');

  const existing = await productRepo.findCategoryById(actor.tenantId, id);
  if (!existing) throw new NotFoundError('Product');

  const clean = await cleanCategoryInput(actor.tenantId, input ?? {}, switchedOffBrand);
  await assertCategoryFree(
    actor.tenantId,
    {
      name: clean.name ?? existing.name,
      code: clean.code ?? existing.code,
      brand: clean.brand !== undefined ? clean.brand : existing.brand,
    },
    id,
  );

  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const [field, to] of Object.entries(clean)) {
    const from = existing[field as keyof ProductCategory];
    if (from !== to) changes[field] = { from, to };
  }
  if (Object.keys(changes).length === 0) return existing;

  const category = await db()
    .transaction(async (trx) => {
      const row = await productRepo.updateCategoryColumns(actor.tenantId, id, clean, trx);
      if (!row) throw new NotFoundError('Product');
      await recordCategoryActivity(actor, row, 'updated', trx, { changes });
      return row;
    })
    .catch((error: unknown) => {
      throw categoryClash(error, {
        name: clean.name ?? existing.name,
        code: clean.code ?? existing.code,
      });
    });

  publishChange({ entity: 'product_category', action: 'updated', id, payload: category });
  if (changes.name || changes.code || changes.brand) publishCatalogueMoved(actor, id);

  return category;
}

/**
 * Into the Recycle Bin, refused while any live sub product sits under it —
 * each named in `blockedBy`, so the screen can say what has to go first.
 */
export async function deleteCategory(
  id: string,
  actor: ActorContext,
): Promise<{ id: string; deletedAt: string }> {
  requirePermission(actor, 'products.delete');

  const category = await db().transaction(async (trx) => {
    // Locked before the count, and counted in here: a sub product being saved
    // under it holds the row `FOR KEY SHARE` (`resolveCategoryId`), so this
    // waits for that save and counts it, and a save arriving after waits for
    // this and finds the category binned.
    const existing = await productRepo.findCategoryById(actor.tenantId, id, trx, {
      forUpdate: true,
    });
    if (!existing) throw new NotFoundError('Product');

    const live = await productRepo.liveSubProducts(actor.tenantId, id, trx);
    if (live.length > 0) {
      throw new ConflictError(
        'error.conflict.blockedByLiveReferences',
        {},
        {
          blockedBy: live.map((sub): BinBlocker => ({
            entityType: 'product',
            id: sub.id,
            label: sub.codes ? `${sub.name} (${sub.codes})` : sub.name,
            reason: 'live_reference',
          })),
        },
      );
    }

    const row = await productRepo.setCategoryDeletedAt(actor.tenantId, id, 'now', trx);
    if (!row) throw new NotFoundError('Product');
    await recordCategoryActivity(actor, row, 'deleted', trx);
    return row;
  });

  publishChange({ entity: 'product_category', action: 'deleted', id, payload: category });
  return { id: category.id, deletedAt: category.deletedAt ?? category.updatedAt };
}

/**
 * Back from the Recycle Bin. Its code cannot be renamed on the way out — a
 * code is letters and digits, and a "(restored)" suffix is not — so a code
 * taken since is refused; a name taken since (same brand) is offered the
 * usual deterministic rename.
 */
export async function restoreCategory(
  id: string,
  actor: ActorContext,
  renameTo: string | undefined,
): Promise<BinRestoreResult> {
  requirePermission(actor, 'products.delete');

  const existing = await productRepo.findCategoryById(actor.tenantId, id, db(), {
    includeDeleted: true,
  });
  if (!existing) throw new NotFoundError('Product');

  if (existing.code) {
    const byCode = await productRepo.findLiveCategoryByCode(actor.tenantId, existing.code);
    if (byCode && byCode.id !== id) {
      throw new ConflictError('error.conflict.categoryCodeTaken', { code: existing.code });
    }
  }

  const desired = renameTo?.trim() || existing.name;
  const taken = async (candidate: string): Promise<boolean> => {
    const row = await productRepo.findLiveCategoryByBrandName(
      actor.tenantId,
      existing.brand,
      candidate,
    );
    return row !== null && row.id !== id;
  };
  if (await taken(desired)) {
    const suggestion = await suggestRestoredName(existing.name, taken);
    throw new ConflictError(
      'error.conflict.restoreCollision',
      { field: 'name' },
      { field: 'name', value: desired, suggestion },
    );
  }

  const category = await db()
    .transaction(async (trx) => {
      const row = await productRepo.setCategoryDeletedAt(
        actor.tenantId,
        id,
        null,
        trx,
        desired !== existing.name ? desired : undefined,
      );
      if (!row) throw new NotFoundError('Product');
      await recordCategoryActivity(
        actor,
        row,
        'restored',
        trx,
        renameTo ? { renamedTo: desired } : {},
      );
      return row;
    })
    .catch((error: unknown) => {
      throw categoryClash(error, { name: desired, code: existing.code });
    });

  publishChange({ entity: 'product_category', action: 'restored', id, payload: category });
  return {
    entityType: 'product_category',
    id,
    renamedTo: renameTo ? desired : undefined,
    alsoRestored: [],
  };
}

// --- Party-specific variants ----------------------------------------------

export async function listVariantsForParty(
  partyId: string,
  actor: ActorContext,
): Promise<PartyProductVariant[]> {
  requirePermission(actor, 'parties.view');
  // A party variant is one party's own version of a product, so it is exactly
  // as private as the party it belongs to.
  await requirePartyAccess(partyId, 'view', actor);

  return variantRepo.listForParty(actor.tenantId, partyId);
}

/** A party's own record plus the catalogue model it stands for, named. */
export type PartyRecord = PartyProductVariant & { catalogueName: string | null };

/**
 * `listVariantsForParty` with the catalogue name resolved, for the Master's
 * party screen. `catalogueName` is null when the product is deleted or the
 * caller may not read the catalogue. The hub's `partyVariant:list` keeps the
 * plain service.
 */
export async function listPartyRecords(
  partyId: string,
  actor: ActorContext,
): Promise<PartyRecord[]> {
  const variants = await listVariantsForParty(partyId, actor);
  const names = actorCan(actor, 'products.view')
    ? await productRepo.findProductsByIds(
        actor.tenantId,
        [...new Set(variants.map((variant) => variant.productId))],
        undefined,
        { includeDeleted: false },
      )
    : new Map();
  return variants.map((variant) => ({
    ...variant,
    catalogueName: names.get(variant.productId)?.name ?? null,
  }));
}

/** The caller's own grant on one party; null = unassigned (open) or no grant of theirs. */
export type PartyMyAccess = PartyAccessLevel | null;

/** `getParty` plus the caller's own access to it — what the Master's detail screen shows everyone. */
export async function getPartyWithAccess(
  id: string,
  actor: ActorContext,
): Promise<Party & { myAccess: PartyMyAccess }> {
  const party = await getParty(id, actor);
  const [grant] = await partyAccessRepo.grantsForUser(
    actor.tenantId,
    resolvePartyScope(actor).userId,
    [id],
  );
  return { ...party, myAccess: grant?.level ?? null };
}

/** `listParties` with each row's own-record count and the caller's own access to it. */
export async function listPartiesWithMeta(
  query: PartyListQuery,
  actor: ActorContext,
): Promise<Paginated<Party & { recordCount: number; myAccess: PartyMyAccess; accessCount: number }>> {
  const page = await listParties(query, actor);
  const ids = page.items.map((party) => party.id);
  const [counts, grants, accessCounts] = await Promise.all([
    variantRepo.countByParty(actor.tenantId, ids),
    partyAccessRepo.grantsForUser(actor.tenantId, resolvePartyScope(actor).userId, ids),
    partyAccessRepo.grantCounts(actor.tenantId, ids),
  ]);
  const levels = new Map(grants.map((grant) => [grant.partyId, grant.level]));
  return {
    ...page,
    items: page.items.map((party) => ({
      ...party,
      recordCount: counts.get(party.id) ?? 0,
      myAccess: levels.get(party.id) ?? null,
      // How many people hold a grant: 0 is an open party, 1 is private to its one holder.
      accessCount: accessCounts.get(party.id) ?? 0,
    })),
  };
}

export async function upsertVariant(
  input: PartyProductVariantInput,
  actor: ActorContext,
): Promise<PartyProductVariant> {
  requirePermission(actor, 'parties.edit');

  // Access first: for somebody who may not see the party, "no such party" and "not yours" must read the same.
  await requirePartyAccess(input.partyId, 'manage', actor);
  const party = await partyRepo.findPartyById(actor.tenantId, input.partyId);
  if (!party) throw new NotFoundError('Party');
  const product = await productRepo.findProductById(actor.tenantId, input.productId);
  if (!product) throw new NotFoundError('Product');

  const variant = await db().transaction(async (trx) => {
    const hlc = await nextHlc(trx);
    const row = await variantRepo.upsertVariant({ tenantId: actor.tenantId, hlc }, input, trx);

    // Filed under the party, not as a `party_variant` of its own: the Logs
    // screen's party scope (`partyScopeLogSql`) narrows only lead, order and
    // party entries, and this one names the party and what it calls the
    // product — exactly as private as the party itself.
    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'party',
        entityId: party.id,
        action: 'variant_saved',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { name: party.name, product: product.name, productId: product.id },
      },
      actor,
      trx,
    );

    return row;
  });

  publishChange({
    entity: 'party_variant',
    action: 'updated',
    id: variant.id,
    payload: variant,
  });

  return variant;
}

export async function countParties(actor: ActorContext): Promise<number> {
  return partyRepo.countParties(actor.tenantId, resolvePartyScope(actor));
}

export async function countProducts(tenantId: string): Promise<number> {
  return productRepo.countProducts(tenantId);
}
