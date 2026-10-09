/**
 * Fields Management: option lists and custom-field definitions
 * (docs/LEAD_GENERATION_FLOW.md §3.1; write surface added in
 * `docs/backend-modules/04-API-CONTRACT.md` §5, Stage 3).
 *
 * Cached per tenant: every lead and order read consults them to work out
 * whether the record is complete, and they change about as often as the
 * company reorganises. The cache went live-write for the first time in Stage
 * 3 — **every function below that writes a row must call
 * `invalidateFieldCache(tenantId)`** once its transaction commits, or every
 * subsequent read in this process serves the pre-write value until the Master
 * restarts, which on a shop PC means until it closes for the day.
 *
 * `listDefinitions`/`listOptions` filter `deleted_at IS NULL` unconditionally
 * — never a caller-supplied toggle. Both feed `SyncSnapshot` via
 * `buildSnapshot`'s `Promise.all` (`snapshot.service.ts`), and a deleted value
 * that reached a panel would render there offline forever. `is_active` is a
 * different question (configured, but hidden from pickers) and stays exactly
 * as it always has: still returned, filtered by the caller.
 */

import { randomUUID } from 'node:crypto';

import type { CustomFieldDefinition, CustomFieldEntity, OptionListItem } from '@orderbook/shared';
import type { Knex } from 'knex';

import { db } from '../db/knex.js';
import { mapCustomFieldDefinition, mapOptionListItem } from './mappers.js';
import type { TransactionContext } from './transaction.js';

type Runner = Knex | Knex.Transaction;

const fieldCache = new Map<string, CustomFieldDefinition[]>();
const optionCache = new Map<string, OptionListItem[]>();

export function invalidateFieldCache(tenantId?: string): void {
  if (tenantId) {
    fieldCache.delete(tenantId);
    optionCache.delete(tenantId);
  } else {
    fieldCache.clear();
    optionCache.clear();
  }
}

export async function listDefinitions(
  tenantId: string,
  runner: Runner = db(),
): Promise<CustomFieldDefinition[]> {
  const cached = fieldCache.get(tenantId);
  if (cached) return cached;

  const rows = await runner('custom_field_definitions')
    .where({ tenant_id: tenantId })
    .whereNull('deleted_at')
    .orderBy(['entity', 'sequence'])
    .select('*');

  const definitions = rows.map(mapCustomFieldDefinition);
  fieldCache.set(tenantId, definitions);
  return definitions;
}

export async function definitionsFor(
  tenantId: string,
  entity: CustomFieldEntity,
  runner: Runner = db(),
): Promise<CustomFieldDefinition[]> {
  const all = await listDefinitions(tenantId, runner);
  return all.filter((definition) => definition.entity === entity);
}

export async function listOptions(
  tenantId: string,
  runner: Runner = db(),
): Promise<OptionListItem[]> {
  const cached = optionCache.get(tenantId);
  if (cached) return cached;

  const rows = await runner('option_lists')
    .where({ tenant_id: tenantId })
    .whereNull('deleted_at')
    .orderBy(['list_key', 'sequence'])
    .select('*');

  const options = rows.map(mapOptionListItem);
  optionCache.set(tenantId, options);
  return options;
}

/**
 * Whether a value is one of a configured list's options.
 *
 * Unknown values are rejected rather than passed through: `sourcePlatform` is a
 * reporting dimension, and a typo'd "whatsap" would quietly become its own
 * category in every breakdown that groups by it.
 */
export async function isValidOption(
  tenantId: string,
  listKey: string,
  value: string,
  runner: Runner = db(),
): Promise<boolean> {
  const options = await listOptions(tenantId, runner);
  return options.some(
    (option) => option.listKey === listKey && option.value === value && option.isActive,
  );
}

// --- Option-list values: the Fields management surface --------------------

/**
 * One list's values, for the Fields screen itself — never cached, and
 * distinct from `listOptions()`, which is every list at once for the
 * read-only surfaces that must stay ungated (`04-API-CONTRACT.md` §5.6).
 */
export async function listOptionsForKey(
  tenantId: string,
  listKey: string,
  options: { includeDeleted?: boolean } = {},
  runner: Runner = db(),
): Promise<OptionListItem[]> {
  let query = runner('option_lists').where({ tenant_id: tenantId, list_key: listKey });
  if (!options.includeDeleted) query = query.whereNull('deleted_at');

  // Two values can share a sequence (a new one is numbered one past the count, which a
  // delete leaves taken): the older first, so every read, an export too, sees one order.
  const rows = await query.orderBy(['sequence', 'created_at', 'id']).select('*');
  return rows.map(mapOptionListItem);
}

export async function findOptionById(
  tenantId: string,
  id: string,
  options: { includeDeleted?: boolean } = {},
  runner: Runner = db(),
): Promise<OptionListItem | null> {
  let query = runner('option_lists').where({ tenant_id: tenantId, id });
  if (!options.includeDeleted) query = query.whereNull('deleted_at');

  const row = await query.first('*');
  return row ? mapOptionListItem(row) : null;
}

export async function isOptionValueTaken(
  tenantId: string,
  listKey: string,
  value: string,
  excludeId: string | null,
  runner: Runner = db(),
): Promise<boolean> {
  let query = runner('option_lists')
    .where({ tenant_id: tenantId, list_key: listKey, value })
    .whereNull('deleted_at');
  if (excludeId) query = query.andWhereNot('id', excludeId);

  return (await query.first('id')) !== undefined;
}

export interface InsertOptionInput {
  tenantId: string;
  listKey: string;
  value: string;
  label: string;
  hex: string | null;
  sequence: number;
  createdBy: string | null;
}

export async function insertOption(input: InsertOptionInput, trx: TransactionContext): Promise<string> {
  const id = randomUUID();

  await trx('option_lists').insert({
    id,
    tenant_id: input.tenantId,
    list_key: input.listKey,
    value: input.value,
    label: input.label,
    hex: input.hex,
    sequence: input.sequence,
    is_active: true,
    created_by: input.createdBy,
    updated_by: input.createdBy,
    version: 1,
  });

  return id;
}

export interface UpdateOptionInput {
  label?: string;
  hex?: string | null;
  isActive?: boolean;
  updatedBy: string | null;
}

/** Bumps `version` in the same `UPDATE` as the edit — never a separate statement. */
export async function updateOptionColumns(
  tenantId: string,
  id: string,
  patch: UpdateOptionInput,
  trx: TransactionContext,
): Promise<void> {
  const columns: Record<string, unknown> = { updated_by: patch.updatedBy, updated_at: trx.fn.now() };
  if (patch.label !== undefined) columns.label = patch.label;
  if (patch.hex !== undefined) columns.hex = patch.hex;
  if (patch.isActive !== undefined) columns.is_active = patch.isActive;

  await trx('option_lists')
    .where({ tenant_id: tenantId, id })
    .update({ ...columns, version: trx.raw('version + 1') });
}

export async function softDeleteOption(
  tenantId: string,
  id: string,
  deletedBy: string | null,
  trx: TransactionContext,
): Promise<void> {
  await trx('option_lists')
    .where({ tenant_id: tenantId, id })
    .update({ deleted_at: trx.fn.now(), deleted_by: deletedBy, version: trx.raw('version + 1') });
}

export async function restoreOption(tenantId: string, id: string, trx: TransactionContext): Promise<void> {
  await trx('option_lists')
    .where({ tenant_id: tenantId, id })
    .update({ deleted_at: null, deleted_by: null, version: trx.raw('version + 1') });
}

/** Writes the complete `1..N` sequence in one round trip. */
export async function reorderOptions(
  tenantId: string,
  ordered: ReadonlyArray<{ id: string; sequence: number }>,
  trx: TransactionContext,
): Promise<void> {
  for (const { id, sequence } of ordered) {
    await trx('option_lists').where({ tenant_id: tenantId, id }).update({ sequence });
  }
}

// --- Custom-field definitions: the Fields management surface --------------

/**
 * Every definition, deleted included — a management-screen affordance, so it
 * goes straight to the database rather than growing a second cache shape
 * nobody else needs. `listDefinitions()` above stays the cached, live-only
 * read that feeds `buildSnapshot` and `evaluateCompleteness`.
 */
export async function listDefinitionsIncludingDeleted(
  tenantId: string,
  entity: CustomFieldEntity | undefined,
  runner: Runner = db(),
): Promise<CustomFieldDefinition[]> {
  const rows = await runner('custom_field_definitions')
    .where({ tenant_id: tenantId, ...(entity ? { entity } : {}) })
    .orderBy(['entity', 'sequence'])
    .select('*');

  return rows.map(mapCustomFieldDefinition);
}

export async function findDefinitionById(
  tenantId: string,
  id: string,
  options: { includeDeleted?: boolean } = {},
  runner: Runner = db(),
): Promise<CustomFieldDefinition | null> {
  let query = runner('custom_field_definitions').where({ tenant_id: tenantId, id });
  if (!options.includeDeleted) query = query.whereNull('deleted_at');

  const row = await query.first('*');
  return row ? mapCustomFieldDefinition(row) : null;
}

export async function isDefinitionKeyTaken(
  tenantId: string,
  entity: CustomFieldEntity,
  key: string,
  excludeId: string | null,
  runner: Runner = db(),
): Promise<boolean> {
  let query = runner('custom_field_definitions')
    .where({ tenant_id: tenantId, entity, key })
    .whereNull('deleted_at');
  if (excludeId) query = query.andWhereNot('id', excludeId);

  return (await query.first('id')) !== undefined;
}

export interface InsertDefinitionInput {
  tenantId: string;
  entity: CustomFieldEntity;
  key: string;
  label: string;
  fieldType: CustomFieldDefinition['fieldType'];
  isRequired: boolean;
  options: string[];
  sequence: number;
}

export async function insertDefinition(
  input: InsertDefinitionInput,
  trx: TransactionContext,
): Promise<string> {
  const id = randomUUID();

  await trx('custom_field_definitions').insert({
    id,
    tenant_id: input.tenantId,
    entity: input.entity,
    key: input.key,
    label: input.label,
    field_type: input.fieldType,
    is_required: input.isRequired,
    options: JSON.stringify(input.options),
    sequence: input.sequence,
    is_active: true,
    version: 1,
  });

  return id;
}

export interface UpdateDefinitionInput {
  label?: string;
  isRequired?: boolean;
  options?: string[];
  isActive?: boolean;
}

export async function updateDefinitionColumns(
  tenantId: string,
  id: string,
  patch: UpdateDefinitionInput,
  trx: TransactionContext,
): Promise<void> {
  const columns: Record<string, unknown> = { updated_at: trx.fn.now() };
  if (patch.label !== undefined) columns.label = patch.label;
  if (patch.isRequired !== undefined) columns.is_required = patch.isRequired;
  if (patch.options !== undefined) columns.options = JSON.stringify(patch.options);
  if (patch.isActive !== undefined) columns.is_active = patch.isActive;

  await trx('custom_field_definitions')
    .where({ tenant_id: tenantId, id })
    .update({ ...columns, version: trx.raw('version + 1') });
}

export async function softDeleteDefinition(
  tenantId: string,
  id: string,
  deletedBy: string | null,
  trx: TransactionContext,
): Promise<void> {
  await trx('custom_field_definitions')
    .where({ tenant_id: tenantId, id })
    .update({ deleted_at: trx.fn.now(), deleted_by: deletedBy, version: trx.raw('version + 1') });
}

export async function restoreDefinition(tenantId: string, id: string, trx: TransactionContext): Promise<void> {
  await trx('custom_field_definitions')
    .where({ tenant_id: tenantId, id })
    .update({ deleted_at: null, deleted_by: null, version: trx.raw('version + 1') });
}

export async function reorderDefinitions(
  tenantId: string,
  ordered: ReadonlyArray<{ id: string; sequence: number }>,
  trx: TransactionContext,
): Promise<void> {
  for (const { id, sequence } of ordered) {
    await trx('custom_field_definitions').where({ tenant_id: tenantId, id }).update({ sequence });
  }
}
