/**
 * Fields Management definitions (docs/LEAD_GENERATION_FLOW.md §3.1).
 *
 * Cached per tenant like pipelines, and for the same reason: every lead and
 * order read consults them to work out whether the record is complete, and they
 * change about as often as the company reorganises.
 */

import type { CustomFieldDefinition, CustomFieldEntity, OptionListItem } from '@orderbook/shared';
import type { Knex } from 'knex';

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

export async function listDefinitions(
  tenantId: string,
  runner: Runner = db(),
): Promise<CustomFieldDefinition[]> {
  const cached = fieldCache.get(tenantId);
  if (cached) return cached;

  const rows = await runner('custom_field_definitions')
    .where({ tenant_id: tenantId })
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
