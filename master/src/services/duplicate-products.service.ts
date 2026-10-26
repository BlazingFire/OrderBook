/**
 * The duplicate-products menu: find the same Product or sub product written
 * twice, and put the extra copies into the Recycle Bin.
 *
 * Nothing here deletes by itself. A delete is `catalog.deleteProduct` /
 * `deleteCategory` — the same soft delete the Products screens use, with its
 * activity row and its `publishChange(… 'deleted')`, which is what every
 * Office folds into its snapshot (`shared/src/sync/apply-change.ts`) — and
 * which still refuses a sub product a live lead or order quotes, and a Product
 * that still holds live sub products. A refused copy is reported and left;
 * the others still go.
 */

import {
  isDuplicateLevel,
  type DuplicateBlock,
  type DuplicateGroup,
  type DuplicateLevel,
  type DuplicateReport,
  type DuplicateResolveInput,
  type DuplicateResolveResult,
} from '@orderbook/shared';

import { requirePermission, type ActorContext } from '../domain/actor.js';
import { findDuplicateGroups, type DuplicateCandidate } from '../domain/duplicate-products.js';
import { db } from '../db/knex.js';
import { ConflictError, ValidationError } from '../lib/errors.js';
import * as productRepo from '../repositories/product.repository.js';
import * as catalog from './catalog.service.js';

/** Finding and deleting duplicates is a delete: the same key as the Recycle Bin restore. */
const PERMISSION = 'products.delete';

async function groupsOf(level: DuplicateLevel, tenantId: string): Promise<DuplicateGroup[]> {
  if (level === 'product') {
    const categories = await productRepo.listCategories(tenantId, db());
    return findDuplicateGroups(
      level,
      categories.map(
        (category): DuplicateCandidate => ({
          id: category.id,
          name: category.name,
          codes: category.code ? [category.code] : [],
          brand: category.brand,
          categoryId: null,
          productName: null,
          size: null,
          subProductCount: category.subProductCount,
          lineCount: 0,
          createdAt: category.createdAt,
        }),
      ),
    );
  }

  const subProducts = await productRepo.listSubProductsForDuplicates(tenantId, db());
  return findDuplicateGroups(
    level,
    subProducts.map(
      (row): DuplicateCandidate => ({
        id: row.id,
        name: row.name,
        codes: row.codes,
        brand: row.brand,
        categoryId: row.categoryId,
        productName: row.categoryName,
        size: row.size,
        subProductCount: 0,
        lineCount: row.lineCount,
        createdAt: row.createdAt,
      }),
    ),
  );
}

export async function findDuplicates(actor: ActorContext): Promise<DuplicateReport> {
  requirePermission(actor, PERMISSION);
  const [products, subProducts] = await Promise.all([
    groupsOf('product', actor.tenantId),
    groupsOf('subProduct', actor.tenantId),
  ]);
  return { groups: [...products, ...subProducts] };
}

export async function resolveDuplicates(
  input: DuplicateResolveInput,
  actor: ActorContext,
): Promise<DuplicateResolveResult> {
  requirePermission(actor, PERMISSION);

  if (
    !isDuplicateLevel(input?.level) ||
    typeof input.keepId !== 'string' ||
    !Array.isArray(input.deleteIds) ||
    input.deleteIds.length === 0 ||
    input.deleteIds.some((id) => typeof id !== 'string' || id === input.keepId)
  ) {
    throw new ValidationError('validation.duplicates.selection');
  }

  // Re-found now, not trusted from the screen: the kept copy and every copy
  // to delete must sit in one group today, so this cannot be pointed at a row
  // that is not a duplicate of anything.
  const group = (await groupsOf(input.level, actor.tenantId)).find((candidate) =>
    candidate.members.some((member) => member.id === input.keepId),
  );
  const members = new Map(group?.members.map((member) => [member.id, member]));
  if (!group || input.deleteIds.some((id) => !members.has(id))) {
    throw new ValidationError('validation.duplicates.selection');
  }

  // Suspect-only groups (near-name, code-variant) are never auto-deleted: a
  // human renames or merges first, then resolves the exact group that remains.
  if (group.matchedOn.every((kind) => kind === 'near-name' || kind === 'code-variant')) {
    throw new ValidationError('validation.duplicates.suspect');
  }

  const result: DuplicateResolveResult = { deleted: [], refused: [] };
  for (const id of new Set(input.deleteIds)) {
    const blockedBy = members.get(id)?.blockedBy ?? null;
    if (blockedBy) {
      result.refused.push({ id, blockedBy });
      continue;
    }
    try {
      if (input.level === 'product') await catalog.deleteCategory(id, actor);
      else await catalog.deleteProduct(id, actor);
      result.deleted.push(id);
    } catch (error) {
      // A line or sub product that arrived since the group was read.
      if (!(error instanceof ConflictError)) throw error;
      const raced: DuplicateBlock = input.level === 'product' ? 'subProducts' : 'liveReferences';
      result.refused.push({ id, blockedBy: raced });
    }
  }
  return result;
}
