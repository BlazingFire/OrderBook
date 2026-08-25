/**
 * Fields Management definitions (docs/LEAD_GENERATION_FLOW.md §3.1).
 *
 * Cached per tenant like pipelines, and for the same reason: every lead and
 * order read consults them to work out whether the record is complete, and they
 * change about as often as the company reorganises.
 *
 * The write-side functions below (Stage 3,
 * `docs/backend-modules/11-BUILD-SEQUENCE.md`) are a separate concern from the
 * cached bulk reads above them: every write invalidates the cache explicitly
 * rather than trying to patch it in place.
 */

import type { CustomFieldDefinition, CustomFieldEntity, OptionListItem } from '@orderbook/shared';
import type { Knex } from 'knex';

import type { TransactionContext } from './transaction.js';
import { db } from '../db/knex.js';
import { mapCustomFieldDefinition, mapOptionListItem } from './mappers.js';

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

/**
 * Removed definitions are excluded by default, because this is the read every
 * lead and order completeness check runs through: a removed required field
 * that stayed in the set would keep marking records incomplete against a
 * field no screen can satisfy any more. Only the Fields screen's own
 * management view asks for the tombstones, and that read bypasses the cache
 * so the two result sets never overwrite each other.
 */
export async function listDefinitions(
  tenantId: string,
  options: { includeDeleted?: boolean } = {},
  runner: Runner = db(),
): Promise<CustomFieldDefinition[]> {
  const liveOnly = !options.includeDeleted;

  if (liveOnly) {
    const cached = fieldCache.get(tenantId);
    if (cached) return cached;
  }

  let query = runner('custom_field_definitions').where({ tenant_id: tenantId });
  if (liveOnly) query = query.whereNull('deleted_at');
  const rows = await query.orderBy(['entity', 'sequence']).select('*');

  const definitions = rows.map(mapCustomFieldDefinition);
  if (liveOnly) fieldCache.set(tenantId, definitions);
  return definitions;
}

export async function definitionsFor(
  tenantId: string,
  entity: CustomFieldEntity,
  runner: Runner = db(),
): Promise<CustomFieldDefinition[]> {
  const all = await listDefinitions(tenantId, {}, runner);
  return all.filter((definition) => definition.entity === entity);
}

/**
 * Removed values are excluded here rather than in each caller: this set is
 * what the panels' snapshot renders and what `isValidOption` below validates
 * against, so a value left in it would keep being offered and keep being
 * accepted after the Fields screen says it is gone.
 */
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

// --- Option-list values: writes (Stage 3) -----------------------------------

const OPTION_TABLE = 'option_lists';
const FIELD_TABLE = 'custom_field_definitions';

export async function optionValuesForKey(
  tenantId: string,
  listKey: string,
  options: { includeDeleted?: boolean } = {},
  runner: Runner = db(),
): Promise<OptionListItem[]> {
  let query = runner(OPTION_TABLE).where({ tenant_id: tenantId, list_key: listKey });
  if (!options.includeDeleted) query = query.whereNull('deleted_at');
  const rows = await query.orderBy('sequence').select('*');
  return rows.map(mapOptionListItem);
}

/** Locks the row for the life of the caller's transaction — the version race's other half. */
export async function lockOptionListItem(
  tenantId: string,
  id: string,
  trx: TransactionContext,
): Promise<OptionListItem | null> {
  const row = await trx(OPTION_TABLE).where({ tenant_id: tenantId, id }).forUpdate().first('*');
  return row ? mapOptionListItem(row) : null;
}

export async function isOptionValueTaken(
  tenantId: string,
  listKey: string,
  value: string,
  excludeId: string | undefined,
  runner: Runner = db(),
): Promise<boolean> {
  let query = runner(OPTION_TABLE)
    .where({ tenant_id: tenantId, list_key: listKey, value })
    .whereNull('deleted_at');
  if (excludeId) query = query.whereNot('id', excludeId);
  const row = await query.first('id');
  return row !== undefined;
}

export async function insertOptionListItem(
  tenantId: string,
  input: { id: string; listKey: string; value: string; label: string; hex: string | null; sequence: number },
  trx: TransactionContext,
): Promise<OptionListItem> {
  const [row] = await trx(OPTION_TABLE)
    .insert({
      id: input.id,
      tenant_id: tenantId,
      list_key: input.listKey,
      value: input.value,
      label: input.label,
      hex: input.hex,
      sequence: input.sequence,
      is_active: true,
      created_at: trx.fn.now(),
      updated_at: trx.fn.now(),
    })
    .returning('*');
  return mapOptionListItem(row);
}

export async function updateOptionListItem(
  tenantId: string,
  id: string,
  patch: { label?: string; hex?: string | null; isActive?: boolean },
  trx: TransactionContext,
): Promise<OptionListItem | null> {
  const [row] = await trx(OPTION_TABLE)
    .where({ tenant_id: tenantId, id })
    .update({
      ...patch,
      version: trx.raw('version + 1'),
      updated_at: trx.fn.now(),
    })
    .returning('*');
  return row ? mapOptionListItem(row) : null;
}

export async function softDeleteOptionListItem(
  tenantId: string,
  id: string,
  deletedBy: string | null,
  trx: TransactionContext,
): Promise<OptionListItem | null> {
  const [row] = await trx(OPTION_TABLE)
    .where({ tenant_id: tenantId, id })
    .update({
      deleted_at: trx.fn.now(),
      deleted_by: deletedBy,
      version: trx.raw('version + 1'),
      updated_at: trx.fn.now(),
    })
    .returning('*');
  return row ? mapOptionListItem(row) : null;
}

export async function restoreOptionListItem(
  tenantId: string,
  id: string,
  trx: TransactionContext,
): Promise<OptionListItem | null> {
  const [row] = await trx(OPTION_TABLE)
    .where({ tenant_id: tenantId, id })
    .update({
      deleted_at: null,
      deleted_by: null,
      version: trx.raw('version + 1'),
      updated_at: trx.fn.now(),
    })
    .returning('*');
  return row ? mapOptionListItem(row) : null;
}

/** No sequence-uniqueness constraint on `option_lists` — a plain per-row update, no deferral needed. */
export async function reorderOptionListItems(
  tenantId: string,
  orderedIds: readonly string[],
  trx: TransactionContext,
): Promise<void> {
  for (const [index, id] of orderedIds.entries()) {
    await trx(OPTION_TABLE)
      .where({ tenant_id: tenantId, id })
      .update({ sequence: index + 1, updated_at: trx.fn.now() });
  }
}

// --- Custom-field definitions: writes (Stage 3) -----------------------------

/**
 * Non-cached, unlike `definitionsFor` above — for reading back a set
 * immediately after a write inside the same transaction, where the
 * per-tenant cache would still hold the pre-write rows.
 */
export async function definitionsForEntity(
  tenantId: string,
  entity: CustomFieldEntity,
  runner: Runner = db(),
): Promise<CustomFieldDefinition[]> {
  const rows = await runner(FIELD_TABLE)
    .where({ tenant_id: tenantId, entity })
    .whereNull('deleted_at')
    .orderBy('sequence')
    .select('*');
  return rows.map(mapCustomFieldDefinition);
}

export async function findDefinitionById(
  tenantId: string,
  id: string,
  options: { includeDeleted?: boolean } = {},
  runner: Runner = db(),
): Promise<CustomFieldDefinition | null> {
  let query = runner(FIELD_TABLE).where({ tenant_id: tenantId, id });
  if (!options.includeDeleted) query = query.whereNull('deleted_at');
  const row = await query.first('*');
  return row ? mapCustomFieldDefinition(row) : null;
}

export async function lockDefinition(
  tenantId: string,
  id: string,
  trx: TransactionContext,
): Promise<CustomFieldDefinition | null> {
  const row = await trx(FIELD_TABLE).where({ tenant_id: tenantId, id }).forUpdate().first('*');
  return row ? mapCustomFieldDefinition(row) : null;
}

export async function isDefinitionKeyTaken(
  tenantId: string,
  entity: CustomFieldEntity,
  key: string,
  excludeId: string | undefined,
  runner: Runner = db(),
): Promise<boolean> {
  let query = runner(FIELD_TABLE).where({ tenant_id: tenantId, entity, key }).whereNull('deleted_at');
  if (excludeId) query = query.whereNot('id', excludeId);
  const row = await query.first('id');
  return row !== undefined;
}

export async function insertDefinition(
  tenantId: string,
  input: {
    id: string;
    entity: CustomFieldEntity;
    key: string;
    label: string;
    fieldType: CustomFieldDefinition['fieldType'];
    isRequired: boolean;
    options: string[];
    sequence: number;
  },
  trx: TransactionContext,
): Promise<CustomFieldDefinition> {
  const [row] = await trx(FIELD_TABLE)
    .insert({
      id: input.id,
      tenant_id: tenantId,
      entity: input.entity,
      key: input.key,
      label: input.label,
      field_type: input.fieldType,
      is_required: input.isRequired,
      options: JSON.stringify(input.options),
      sequence: input.sequence,
      is_active: true,
      created_at: trx.fn.now(),
      updated_at: trx.fn.now(),
    })
    .returning('*');
  return mapCustomFieldDefinition(row);
}

export async function updateDefinition(
  tenantId: string,
  id: string,
  patch: { label?: string; isRequired?: boolean; options?: string[]; isActive?: boolean },
  trx: TransactionContext,
): Promise<CustomFieldDefinition | null> {
  const { options, ...rest } = patch;
  const [row] = await trx(FIELD_TABLE)
    .where({ tenant_id: tenantId, id })
    .update({
      ...rest,
      ...(options ? { options: JSON.stringify(options) } : {}),
      version: trx.raw('version + 1'),
      updated_at: trx.fn.now(),
    })
    .returning('*');
  return row ? mapCustomFieldDefinition(row) : null;
}

export async function softDeleteDefinition(
  tenantId: string,
  id: string,
  deletedBy: string | null,
  trx: TransactionContext,
): Promise<CustomFieldDefinition | null> {
  const [row] = await trx(FIELD_TABLE)
    .where({ tenant_id: tenantId, id })
    .update({
      deleted_at: trx.fn.now(),
      deleted_by: deletedBy,
      version: trx.raw('version + 1'),
      updated_at: trx.fn.now(),
    })
    .returning('*');
  return row ? mapCustomFieldDefinition(row) : null;
}

export async function restoreDefinition(
  tenantId: string,
  id: string,
  trx: TransactionContext,
): Promise<CustomFieldDefinition | null> {
  const [row] = await trx(FIELD_TABLE)
    .where({ tenant_id: tenantId, id })
    .update({
      deleted_at: null,
      deleted_by: null,
      version: trx.raw('version + 1'),
      updated_at: trx.fn.now(),
    })
    .returning('*');
  return row ? mapCustomFieldDefinition(row) : null;
}

/** No sequence-uniqueness constraint on `custom_field_definitions` — a plain per-row update. */
export async function reorderDefinitions(
  tenantId: string,
  orderedIds: readonly string[],
  trx: TransactionContext,
): Promise<void> {
  for (const [index, id] of orderedIds.entries()) {
    await trx(FIELD_TABLE)
      .where({ tenant_id: tenantId, id })
      .update({ sequence: index + 1, updated_at: trx.fn.now() });
  }
}
