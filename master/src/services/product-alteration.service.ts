/**
 * Product alteration: pending only patch of line snapshots with frozen history.
 *
 * Editing a product must not rewrite history. Dispatched orders and converted
 * leads keep the snapshot taken on the day. Pending leads and undispatched
 * orders take the new snapshot columns while product and variant ids stay
 * unchanged. Dispatched and final lines are listed as read only conflicts.
 *
 * The product update itself goes through catalog.service updateProduct, so
 * validation, products.edit permission and the productChanges activity shape
 * stay in one place. This module adds the preview counts, the pending only
 * line patch and the before after PDF for the affected orders.
 */

import type {
  Product,
  ProductAlterationAffected,
  ProductAlterationApplyInput,
  ProductAlterationApplyResult,
  ProductAlterationPreview,
} from '@orderbook/shared';

import { requirePermission, type ActorContext } from '../domain/actor.js';
import { assertFieldsFresh } from '../domain/access.js';
import { UNSCOPED_PARTY_ACCESS } from '../domain/party-scope.js';
import { db } from '../db/knex.js';
import { NotFoundError } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import type { Knex } from 'knex';
import * as activityLog from '../repositories/activity-log.repository.js';
import { nextHlc } from '../repositories/identity.repository.js';
import * as leadRepo from '../repositories/lead.repository.js';
import * as orderRepo from '../repositories/order.repository.js';
import * as productRepo from '../repositories/product.repository.js';
import { renderReportPdf } from '../pdf/table-renderer.js';
import { actorStamp, publishChange } from './change-bus.js';
import { updateProduct } from './catalog.service.js';

const log = createLogger('product-alteration');

const PREVIEW_REF_LIMIT = 100;
const PREVIEW_REF_PER_KIND = 50;
const AFFECTED_LIMIT = 200;
const PATCH_LIMIT = 5000;

interface PendingLine {
  id: string;
  parentType: string;
  parentId: string;
  productId: string;
  variantId: string;
  productName: string | null;
  code: string | null;
  size: string | null;
  alias: string | null;
}

type MatchBuilder = (builder: Knex.QueryBuilder) => void;

function productMatch(productId: string, variantIds: string[]): MatchBuilder {
  return (builder) => {
    void builder.where((inner) => {
      void inner.where('li.product_id', productId);
      if (variantIds.length > 0) void inner.orWhereIn('li.variant_id', variantIds);
    });
  };
}

function toRef(
  parentType: 'lead' | 'order',
  row: {
    parentId: unknown;
    poNumber: unknown;
    partyName: unknown;
    variantId: unknown;
    code: unknown;
    variantLabel: unknown;
    productName: unknown;
    size: unknown;
  },
): ProductAlterationPreview['pending'][number] {
  return {
    parentType,
    parentId: String(row.parentId),
    poNumber: (row.poNumber as string | null) ?? null,
    partyName: (row.partyName as string | null) ?? null,
    variantId: String(row.variantId),
    code: (row.code as string | null) ?? null,
    variantLabel: (row.variantLabel as string | null) ?? null,
    productName: (row.productName as string | null) ?? null,
    size: (row.size as string | null) ?? null,
  };
}

export async function previewProductAlteration(
  productId: string,
  actor: ActorContext,
): Promise<ProductAlterationPreview> {
  requirePermission(actor, 'products.view');
  const product = await productRepo.findProductById(actor.tenantId, productId);
  if (!product) throw new NotFoundError('Product');
  const variantIds = product.variants.map((variant) => variant.id);
  const match = productMatch(productId, variantIds);

  const pendingLeadRows = await db()('line_items as li')
    .join('leads as l', 'l.id', 'li.parent_id')
    .leftJoin('parties as pa', 'pa.id', 'l.party_id')
    .where('li.tenant_id', actor.tenantId)
    .andWhere('li.parent_type', 'lead')
    .andWhere(match)
    .whereNull('l.deleted_at')
    .whereNull('l.converted_order_id')
    .select(
      'li.parent_id as parentId',
      'l.po_number as poNumber',
      'pa.name as partyName',
      'li.variant_id as variantId',
      'li.code as code',
      'li.variant_label as variantLabel',
      'li.product_name as productName',
      'li.size as size',
    )
    .limit(PREVIEW_REF_PER_KIND);

  const pendingOrderRows = await db()('line_items as li')
    .join('orders as o', 'o.id', 'li.parent_id')
    .leftJoin('leads as ld', 'ld.id', 'o.lead_id')
    .leftJoin('parties as pa', 'pa.id', 'o.party_id')
    .where('li.tenant_id', actor.tenantId)
    .andWhere('li.parent_type', 'order')
    .andWhere(match)
    .whereNull('o.deleted_at')
    .whereNull('o.dispatched_at')
    .select(
      'li.parent_id as parentId',
      'ld.po_number as poNumber',
      'pa.name as partyName',
      'li.variant_id as variantId',
      'li.code as code',
      'li.variant_label as variantLabel',
      'li.product_name as productName',
      'li.size as size',
    )
    .limit(PREVIEW_REF_PER_KIND);

  const frozenLeadRows = await db()('line_items as li')
    .join('leads as l', 'l.id', 'li.parent_id')
    .leftJoin('parties as pa', 'pa.id', 'l.party_id')
    .where('li.tenant_id', actor.tenantId)
    .andWhere('li.parent_type', 'lead')
    .andWhere(match)
    .whereNull('l.deleted_at')
    .whereNotNull('l.converted_order_id')
    .select(
      'li.parent_id as parentId',
      'l.po_number as poNumber',
      'pa.name as partyName',
      'li.variant_id as variantId',
      'li.code as code',
      'li.variant_label as variantLabel',
      'li.product_name as productName',
      'li.size as size',
    )
    .limit(PREVIEW_REF_PER_KIND);

  const frozenOrderRows = await db()('line_items as li')
    .join('orders as o', 'o.id', 'li.parent_id')
    .leftJoin('leads as ld', 'ld.id', 'o.lead_id')
    .leftJoin('parties as pa', 'pa.id', 'o.party_id')
    .where('li.tenant_id', actor.tenantId)
    .andWhere('li.parent_type', 'order')
    .andWhere(match)
    .whereNull('o.deleted_at')
    .whereNotNull('o.dispatched_at')
    .select(
      'li.parent_id as parentId',
      'ld.po_number as poNumber',
      'pa.name as partyName',
      'li.variant_id as variantId',
      'li.code as code',
      'li.variant_label as variantLabel',
      'li.product_name as productName',
      'li.size as size',
    )
    .limit(PREVIEW_REF_PER_KIND);

  const pendingLeads = await countParentLines(actor.tenantId, productId, variantIds, 'lead', false);
  const pendingOrders = await countParentLines(
    actor.tenantId,
    productId,
    variantIds,
    'order',
    false,
  );

  const pending = [
    ...pendingLeadRows.map((row) => toRef('lead', row)),
    ...pendingOrderRows.map((row) => toRef('order', row)),
  ].slice(0, PREVIEW_REF_LIMIT);
  const frozenLeads = await countParentLines(actor.tenantId, productId, variantIds, 'lead', true);
  const frozenOrders = await countParentLines(actor.tenantId, productId, variantIds, 'order', true);

  const frozen = [
    ...frozenLeadRows.map((row) => toRef('lead', row)),
    ...frozenOrderRows.map((row) => toRef('order', row)),
  ].slice(0, PREVIEW_REF_LIMIT);

  return {
    productId,
    productName: product.name,
    pendingLeads,
    pendingOrders,
    frozenLeads,
    frozenOrders,
    pending,
    frozen,
  };
}

async function countParentLines(
  tenantId: string,
  productId: string,
  variantIds: string[],
  parentType: 'lead' | 'order',
  frozen: boolean,
): Promise<number> {
  const match = productMatch(productId, variantIds);
  if (parentType === 'lead') {
    const query = db()('line_items as li')
      .join('leads as l', 'l.id', 'li.parent_id')
      .where('li.tenant_id', tenantId)
      .andWhere('li.parent_type', 'lead')
      .andWhere(match)
      .whereNull('l.deleted_at');
    if (frozen) void query.whereNotNull('l.converted_order_id');
    else void query.whereNull('l.converted_order_id');
    const row = await query.clone().countDistinct('li.parent_id as count').first();
    return Number((row as { count: string } | undefined)?.count ?? 0);
  }
  const query = db()('line_items as li')
    .join('orders as o', 'o.id', 'li.parent_id')
    .where('li.tenant_id', tenantId)
    .andWhere('li.parent_type', 'order')
    .andWhere(match)
    .whereNull('o.deleted_at');
  if (frozen) void query.whereNotNull('o.dispatched_at');
  else void query.whereNull('o.dispatched_at');
  const row = await query.clone().countDistinct('li.parent_id as count').first();
  return Number((row as { count: string } | undefined)?.count ?? 0);
}

async function loadPendingLines(
  tenantId: string,
  productId: string,
  variantIds: string[],
): Promise<PendingLine[]> {
  const match = productMatch(productId, variantIds);
  const leadLines = await db()('line_items as li')
    .join('leads as l', 'l.id', 'li.parent_id')
    .where('li.tenant_id', tenantId)
    .andWhere('li.parent_type', 'lead')
    .andWhere(match)
    .whereNull('l.deleted_at')
    .whereNull('l.converted_order_id')
    .select(
      'li.id as id',
      'li.parent_type as parentType',
      'li.parent_id as parentId',
      'li.product_id as productId',
      'li.variant_id as variantId',
      'li.product_name as productName',
      'li.code as code',
      'li.size as size',
      'li.alias as alias',
    )
    .limit(PATCH_LIMIT);
  const orderLines = await db()('line_items as li')
    .join('orders as o', 'o.id', 'li.parent_id')
    .where('li.tenant_id', tenantId)
    .andWhere('li.parent_type', 'order')
    .andWhere(match)
    .whereNull('o.deleted_at')
    .whereNull('o.dispatched_at')
    .select(
      'li.id as id',
      'li.parent_type as parentType',
      'li.parent_id as parentId',
      'li.product_id as productId',
      'li.variant_id as variantId',
      'li.product_name as productName',
      'li.code as code',
      'li.size as size',
      'li.alias as alias',
    )
    .limit(PATCH_LIMIT);
  return [
    ...(leadLines as unknown as PendingLine[]),
    ...(orderLines as unknown as PendingLine[]),
  ].slice(0, PATCH_LIMIT);
}

function sameBlank(left: string | null | undefined, right: string | null | undefined): boolean {
  return (left ?? '').trim() === (right ?? '').trim();
}

function sameLabel(left: string | null | undefined, right: string | null | undefined): boolean {
  const norm = (value: string | null | undefined): string | null => {
    const trimmed = (value ?? '').trim();
    return trimmed === '' ? null : trimmed;
  };
  return norm(left) === norm(right);
}

/**
 * Whether the alteration input changes nothing against the stored product.
 *
 * The screens re-send the live product here: the edit already saved it,
 * and this call only pushes its snapshot into pending lines. A present
 * variant set replaces the whole set, so rewriting an unchanged input
 * would drop the inactive variants the re-send omits. False negatives
 * only take the rewrite path, so every comparison stays strict.
 */
function alterationInputMatchesStored(
  input: ProductAlterationApplyInput['product'],
  stored: Product,
): boolean {
  if ((input.name ?? '').trim() !== stored.name) return false;
  if (input.categoryId !== undefined && input.categoryId !== stored.categoryId) return false;
  if (input.categoryId === undefined && (input.categoryName ?? input.categoryCode)) return false;
  if (!sameBlank(input.alias, stored.alias)) return false;
  if (!sameBlank(input.size, stored.size)) return false;
  if ((input.multiColour ?? false) !== stored.multiColour) return false;
  if ((input.hasVariants ?? stored.hasVariants) !== stored.hasVariants) return false;
  const live = stored.variants.filter((variant) => variant.isActive);
  const want = input.variants ?? [];
  if (want.length !== live.length) return false;
  if (want.some((variant) => !variant.id)) return false;
  const byId = new Map(live.map((variant) => [variant.id, variant]));
  return want.every((variant) => {
    const current = variant.id === undefined ? undefined : byId.get(variant.id);
    if (!current) return false;
    if (variant.sequence !== undefined && variant.sequence !== current.sequence) return false;
    return (
      variant.code.trim() === current.code &&
      sameLabel(variant.label, current.label) &&
      (variant.weightKg ?? null) === (current.weightKg ?? null)
    );
  });
}

export async function applyProductAlteration(
  productId: string,
  input: ProductAlterationApplyInput,
  actor: ActorContext,
): Promise<ProductAlterationApplyResult> {
  requirePermission(actor, 'products.edit');
  requirePermission(actor, 'products.bulk');

  const stored = await productRepo.findProductById(actor.tenantId, productId);
  if (!stored) throw new NotFoundError('Product');
  // A stale conflicts-screen view must not patch over a product someone else
  // saved since: the clocks the screen opened ride on the apply, and any one
  // of them moved refuses the whole apply with 409 instead of last-writer-wins.
  if (input.baseFieldHlc) {
    assertFieldsFresh(Object.keys(input.baseFieldHlc), stored.sync.fieldHlc, input.baseFieldHlc);
  }
  const rewritten = !alterationInputMatchesStored(input.product, stored);
  const updated = rewritten ? await updateProduct(productId, input.product, actor) : stored;

  // Every variant the product holds, active or retired: lines of a retired
  // variant keep its snapshot columns like any other pending line.
  const variantById = new Map(updated.variants.map((variant) => [variant.id, variant]));
  const snapshot = {
    productName: updated.name,
    categoryName: updated.categoryName,
    categoryCode: updated.categoryCode,
    brandName: updated.brand,
    alias: updated.alias,
    size: updated.size,
  };

  const beforeRows = await loadPendingLines(actor.tenantId, productId, [...variantById.keys()]);
  const beforeById = new Map(beforeRows.map((row) => [row.id, row]));
  const ids = [...beforeById.keys()];
  // Distinct parents over every loaded line, not the capped review slice: the
  // patched counts cover all PATCH_LIMIT lines, not the first 200 of them.
  const leadParents = new Set<string>();
  const orderParents = new Set<string>();
  for (const row of beforeRows) {
    if (row.parentType === 'lead') leadParents.add(row.parentId);
    else orderParents.add(row.parentId);
  }
  const leadIds = [...leadParents];
  const orderIds = [...orderParents];
  // One transaction: a failure leaves every pending snapshot as it was,
  // and the apply can simply run again (matching is by id, so it resumes).
  if (ids.length > 0) {
    await db().transaction(async (trx) => {
      await trx('line_items').where('tenant_id', actor.tenantId).whereIn('id', ids).update({
        product_name: snapshot.productName,
        category_name: snapshot.categoryName,
        category_code: snapshot.categoryCode,
        brand_name: snapshot.brandName,
        alias: snapshot.alias,
        size: snapshot.size,
      });
      for (const [variantId, variant] of variantById) {
        const group = ids.filter((id) => beforeById.get(id)?.variantId === variantId);
        if (group.length === 0) continue;
        await trx('line_items').where('tenant_id', actor.tenantId).whereIn('id', group).update({
          code: variant.code,
          variant_label: variant.label,
          weight_kg: variant.weightKg,
        });
      }
      // The lines are snapshots, but the boards and the Office snapshots read
      // the parents: without a clock move here a patched lead keeps its old
      // revision and nothing refreshes until an unrelated write. One HLC for
      // the whole propagation, stamped on every touched parent's items clock.
      const hlc = await nextHlc(trx);
      if (leadIds.length > 0) {
        await trx('leads')
          .where('tenant_id', actor.tenantId)
          .whereIn('id', leadIds)
          .update({
            hlc,
            field_hlc: trx.raw(
              `coalesce(field_hlc, '{}'::jsonb) || jsonb_build_object('items', ?::text)`,
              [hlc],
            ),
            version: trx.raw('version + 1'),
            updated_at: trx.fn.now(),
          });
        for (const id of leadIds) {
          await activityLog.recordActivity(
            {
              tenantId: actor.tenantId,
              entityType: 'lead',
              entityId: id,
              action: 'updated',
              actorType: actor.actorType,
              actorId: actor.actorId,
            },
            actor,
            trx,
          );
        }
      }
      if (orderIds.length > 0) {
        await trx('orders')
          .where('tenant_id', actor.tenantId)
          .whereIn('id', orderIds)
          .update({
            hlc,
            field_hlc: trx.raw(
              `coalesce(field_hlc, '{}'::jsonb) || jsonb_build_object('items', ?::text)`,
              [hlc],
            ),
            version: trx.raw('version + 1'),
            updated_at: trx.fn.now(),
          });
        for (const id of orderIds) {
          await activityLog.recordActivity(
            {
              tenantId: actor.tenantId,
              entityType: 'order',
              entityId: id,
              action: 'updated',
              actorType: actor.actorType,
              actorId: actor.actorId,
            },
            actor,
            trx,
          );
        }
      }
    });
  }

  // After the commit, so a panel never reads a change the database does not
  // hold yet: one event per touched parent, with the full row, the same shape
  // `updateLead` and `updateOrder` publish.
  for (const id of leadIds) {
    const lead = await leadRepo.findLeadById(actor.tenantId, id, UNSCOPED_PARTY_ACCESS);
    if (lead)
      publishChange({ entity: 'lead', action: 'updated', id, payload: lead, ...actorStamp(actor) });
  }
  for (const id of orderIds) {
    const order = await orderRepo.findOrderById(actor.tenantId, id, UNSCOPED_PARTY_ACCESS);
    if (order)
      publishChange({
        entity: 'order',
        action: 'updated',
        id,
        payload: order,
        ...actorStamp(actor),
      });
  }

  // PO numbers for the review: leads carry their own, orders take their lead's.
  const poByParent = await poNumbersForParents(actor.tenantId, leadIds, orderIds);

  const affected: ProductAlterationAffected[] = [];
  for (const row of beforeRows.slice(0, AFFECTED_LIMIT)) {
    const variant = variantById.get(row.variantId);
    affected.push({
      parentType: row.parentType === 'lead' ? 'lead' : 'order',
      parentId: row.parentId,
      poNumber: poByParent.get(row.parentId) ?? null,
      before: {
        product: row.productName ?? '',
        code: row.code ?? '',
        size: row.size ?? '',
      },
      after: {
        product: snapshot.productName ?? '',
        code: variant?.code ?? row.code ?? '',
        size: snapshot.size ?? '',
      },
    });
  }

  const frozenLeads = await countParentLines(
    actor.tenantId,
    productId,
    [...variantById.keys()],
    'lead',
    true,
  );
  const frozenOrders = await countParentLines(
    actor.tenantId,
    productId,
    [...variantById.keys()],
    'order',
    true,
  );

  log.info(
    'Alteration applied to pending lines for product ' +
      productId +
      ': ' +
      String(ids.length) +
      ' lines',
  );

  return {
    productId,
    updated: rewritten,
    pendingLeadsPatched: leadParents.size,
    pendingOrdersPatched: orderParents.size,
    frozenSkipped: frozenLeads + frozenOrders,
    affected,
  };
}

/**
 * PO numbers for the review list: leads carry their own, orders take the PO
 * of the lead they were converted from (null when there is none).
 */
async function poNumbersForParents(
  tenantId: string,
  leadIds: string[],
  orderIds: string[],
): Promise<Map<string, string | null>> {
  const numbers = new Map<string, string | null>();
  if (leadIds.length > 0) {
    const rows = await db()('leads')
      .where('tenant_id', tenantId)
      .whereIn('id', leadIds)
      .select('id', 'po_number as poNumber');
    for (const row of rows as Array<{ id: string; poNumber: string | null }>)
      numbers.set(row.id, row.poNumber);
  }
  if (orderIds.length > 0) {
    const rows = await db()('orders as o')
      .leftJoin('leads as ld', 'ld.id', 'o.lead_id')
      .where('o.tenant_id', tenantId)
      .whereIn('o.id', orderIds)
      .select('o.id as id', 'ld.po_number as poNumber');
    for (const row of rows as Array<{ id: string; poNumber: string | null }>)
      numbers.set(row.id, row.poNumber);
  }
  return numbers;
}

export async function alterationOrdersPdf(
  productName: string,
  affected: ProductAlterationAffected[],
  actor: ActorContext,
): Promise<{ bytes: Buffer; contentType: string; fileName: string }> {
  requirePermission(actor, 'products.view');
  const rows = affected
    .slice(0, AFFECTED_LIMIT)
    .map((entry) => [
      entry.poNumber ?? entry.parentId.slice(0, 8),
      entry.parentType,
      (entry.before.product + ' ' + entry.before.code).trim(),
      (entry.after.product + ' ' + entry.after.code).trim(),
    ]);
  const bytes = await renderReportPdf({
    title: 'Affected orders before after',
    subtitle: productName,
    preamble: [
      'Pending records take the new snapshot. Dispatched and converted history is unchanged.',
    ],
    columns: [{ label: 'Record' }, { label: 'Kind' }, { label: 'Before' }, { label: 'After' }],
    rows,
    paperSize: 'a4',
    orientation: 'landscape',
  });
  const stamp = new Date().toISOString().slice(0, 10);
  return {
    bytes: Buffer.from(bytes),
    contentType: 'application/pdf',
    fileName: 'alteration-' + stamp + '.pdf',
  };
}
