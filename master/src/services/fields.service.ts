/**
 * Fields: managed pipelines, stages, option lists (including colour hex) and
 * custom-field definitions (`docs/backend-modules/04-API-CONTRACT.md` §5).
 *
 * **Reading is available to every tier; editing is management+.** The two
 * unguarded exports at the top (`listPipelinesUnguarded`,
 * `listOptionListsUnguarded`) back the existing
 * `GET /api/pipelines`, `/api/option-lists` routes and
 * `buildSnapshot`'s `Promise.all` — they check nothing, deliberately. Adding a
 * `fields.view` check to any of them would make that `Promise.all` reject for
 * anyone lacking the key, and a rejected `buildSnapshot` produces **no
 * snapshot at all** (swallowed into a log line at `hub.ts`'s `sendSnapshot`).
 * Every other export in this file is gated.
 */

import {
  buildFieldCatalogue,
  FIELD_LIST_KEYS,
  isCustomFieldEntity,
  isFieldListKey,
  type CustomFieldDefinition,
  type CustomFieldDefinitionInput,
  type CustomFieldDefinitionUpdateInput,
  type CustomFieldEntity,
  type CustomFieldReorderInput,
  type FieldCatalogue,
  type FieldListKey,
  type FieldUsage,
  type FieldUsageBreakdown,
  type OptionListItem,
  type OptionListItemInput,
  type OptionListItemUpdateInput,
  type OptionListReorderInput,
  type Pipeline,
  type PipelineStage,
  type PipelineStageInput,
  type StageReorderInput,
} from '@orderbook/shared';

import { actorUserId, requirePermission, type ActorContext } from '../domain/actor.js';
import { fieldDiff, assertVersionMatches } from '../domain/access.js';
import {
  assertCompleteReorder,
  assertHexColour,
  normaliseOptionValue,
  resequence,
} from '../domain/field-values.js';
import { db } from '../db/knex.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import * as activityLog from '../repositories/activity-log.repository.js';
import * as customFieldRepo from '../repositories/custom-field.repository.js';
import * as fieldUsageRepo from '../repositories/field-usage.repository.js';
import * as pipelineRepo from '../repositories/pipeline.repository.js';
import { publishChange } from './change-bus.js';

// --- The three existing reads. Ungated. Do not add a permission check here. ---
// See the file header — this is the one rule in this file that must never
// change without re-reading `04-API-CONTRACT.md` §5.6 first.

export function listPipelinesUnguarded(tenantId: string): Promise<Pipeline[]> {
  return pipelineRepo.listPipelines(tenantId);
}

export function listOptionListsUnguarded(tenantId: string): Promise<OptionListItem[]> {
  return customFieldRepo.listOptions(tenantId);
}

// --- Reads: fields.view -----------------------------------------------------

export function fieldsCatalogue(actor: ActorContext): FieldCatalogue {
  requirePermission(actor, 'fields.view');
  return buildFieldCatalogue();
}

function assertListKey(raw: unknown): FieldListKey {
  if (!isFieldListKey(raw)) {
    throw new ValidationError('validation.fields.listKeyRequired', {}, {
      field: 'listKey',
      allowed: FIELD_LIST_KEYS,
    });
  }
  return raw;
}

export async function listValues(
  query: { listKey: unknown; includeDeleted?: boolean; includeUnlisted?: boolean },
  actor: ActorContext,
): Promise<{ items: OptionListItem[]; unlisted?: string[] }> {
  requirePermission(actor, 'fields.view');
  const listKey = assertListKey(query.listKey);

  const items = await customFieldRepo.listOptionsForKey(actor.tenantId, listKey, {
    includeDeleted: query.includeDeleted,
  });

  if (!query.includeUnlisted) return { items };

  const known = new Set(items.map((item) => item.value));
  const usage = await fieldUsageRepo.usageForListKey(actor.tenantId, listKey);
  const unlisted = [...new Set(usage.map((row) => row.value).filter((value) => !known.has(value)))].sort();

  return { items, unlisted };
}

export async function fieldUsage(
  query: { listKey: unknown },
  actor: ActorContext,
): Promise<FieldUsageBreakdown> {
  requirePermission(actor, 'fields.view');
  const listKey = assertListKey(query.listKey);

  const rows = await fieldUsageRepo.usageForListKey(actor.tenantId, listKey);
  const known = new Set(
    (await customFieldRepo.listOptionsForKey(actor.tenantId, listKey)).map((item) => item.value),
  );

  const byValue = new Map<string, FieldUsage>();
  const sources = new Set<string>();

  for (const row of rows) {
    sources.add(row.source);
    const entry = byValue.get(row.value) ?? { value: row.value, total: 0, bySource: {} };
    entry.total += row.count;
    entry.bySource[row.source] = (entry.bySource[row.source] ?? 0) + row.count;
    byValue.set(row.value, entry);
  }

  const values: FieldUsage[] = [];
  const unlisted: FieldUsage[] = [];
  for (const entry of byValue.values()) {
    (known.has(entry.value) ? values : unlisted).push(entry);
  }
  values.sort((a, b) => a.value.localeCompare(b.value));
  unlisted.sort((a, b) => a.value.localeCompare(b.value));

  return { listKey, sources: [...sources].sort(), values, unlisted };
}

function assertEntity(raw: unknown): CustomFieldEntity {
  if (!isCustomFieldEntity(raw)) {
    throw new ValidationError('validation.fields.entityInvalid', {}, {
      field: 'entity',
      allowed: ['lead', 'order', 'party', 'product'],
    });
  }
  return raw;
}

export async function listDefinitions(
  query: { entity?: unknown; includeDeleted?: boolean },
  actor: ActorContext,
): Promise<CustomFieldDefinition[]> {
  requirePermission(actor, 'fields.view');

  const entity = query.entity === undefined ? undefined : assertEntity(query.entity);
  const rows = query.includeDeleted
    ? await customFieldRepo.listDefinitionsIncludingDeleted(actor.tenantId, entity)
    : await customFieldRepo.listDefinitions(actor.tenantId);

  return entity ? rows.filter((row) => row.entity === entity) : rows;
}

export async function listStages(actor: ActorContext): Promise<Pipeline[]> {
  requirePermission(actor, 'fields.view');
  return pipelineRepo.listPipelines(actor.tenantId);
}

// --- Writes: fields.manage ---------------------------------------------------

export async function createValue(
  input: OptionListItemInput,
  actor: ActorContext,
): Promise<OptionListItem> {
  requirePermission(actor, 'fields.manage');

  const listKey = assertListKey(input.listKey);
  const value = normaliseOptionValue(input.value ?? '');
  if (!value) throw new ValidationError('validation.fields.valueRequired', {}, { field: 'value' });

  const label = input.label?.trim() || value;
  const hex = assertHexColour(input.hex ?? null);

  if (await customFieldRepo.isOptionValueTaken(actor.tenantId, listKey, value, null)) {
    throw new ConflictError('error.conflict.optionValueTaken', { value }, { field: 'value', value });
  }

  const sequence =
    input.sequence ?? (await customFieldRepo.listOptionsForKey(actor.tenantId, listKey)).length + 1;

  const id = await db().transaction(async (trx) => {
    const insertedId = await customFieldRepo.insertOption(
      { tenantId: actor.tenantId, listKey, value, label, hex, sequence, createdBy: actorUserId(actor) },
      trx,
    );

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'option_list_item',
        entityId: insertedId,
        action: 'created',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { name: label, listKey, value },
      },
      actor,
      trx,
    );

    return insertedId;
  });

  customFieldRepo.invalidateFieldCache(actor.tenantId);

  const item = await customFieldRepo.findOptionById(actor.tenantId, id);
  if (!item) throw new Error('Option disappeared immediately after insert');

  publishChange({ entity: 'option_list', action: 'created', id: item.id, payload: item });
  return item;
}

/** `value` and `listKey` are the record-facing identity and are refused if present, even though the input type has no such field. */
function assertNoImmutableFields(body: unknown, fields: readonly string[]): void {
  if (!body || typeof body !== 'object') return;
  const present = fields.filter((field) => Object.prototype.hasOwnProperty.call(body, field));
  if (present.length === 0) return;

  throw new ValidationError('validation.fields.valueImmutable', {}, { field: present[0] });
}

export async function updateValue(
  id: string,
  input: OptionListItemUpdateInput,
  actor: ActorContext,
): Promise<OptionListItem> {
  requirePermission(actor, 'fields.manage');
  assertNoImmutableFields(input, ['value', 'listKey']);

  const existing = await customFieldRepo.findOptionById(actor.tenantId, id);
  if (!existing) throw new NotFoundError('Option');

  assertVersionMatches(
    existing.version,
    input.expectedVersion,
    fieldDiff(
      { label: existing.label, hex: existing.hex, isActive: existing.isActive },
      { label: input.label, hex: input.hex, isActive: input.isActive },
    ),
  );

  const hex = input.hex === undefined ? undefined : assertHexColour(input.hex, 'hex');

  await db().transaction(async (trx) => {
    await customFieldRepo.updateOptionColumns(
      actor.tenantId,
      id,
      {
        label: input.label?.trim() || undefined,
        hex,
        isActive: input.isActive,
        updatedBy: actorUserId(actor),
      },
      trx,
    );

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'option_list_item',
        entityId: id,
        action: 'updated',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { name: input.label ?? existing.label },
      },
      actor,
      trx,
    );
  });

  customFieldRepo.invalidateFieldCache(actor.tenantId);

  const item = await customFieldRepo.findOptionById(actor.tenantId, id);
  if (!item) throw new NotFoundError('Option');

  publishChange({ entity: 'option_list', action: 'updated', id, payload: item });
  return item;
}

export async function deleteValue(
  id: string,
  actor: ActorContext,
): Promise<{ id: string; deletedAt: string }> {
  requirePermission(actor, 'fields.manage');

  const existing = await customFieldRepo.findOptionById(actor.tenantId, id);
  if (!existing) throw new NotFoundError('Option');

  await db().transaction(async (trx) => {
    await customFieldRepo.softDeleteOption(actor.tenantId, id, actorUserId(actor), trx);

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'option_list_item',
        entityId: id,
        action: 'deleted',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { name: existing.label, listKey: existing.listKey, value: existing.value },
      },
      actor,
      trx,
    );
  });

  customFieldRepo.invalidateFieldCache(actor.tenantId);

  const item = await customFieldRepo.findOptionById(actor.tenantId, id, { includeDeleted: true });
  if (!item) throw new NotFoundError('Option');

  publishChange({ entity: 'option_list', action: 'deleted', id, payload: item });
  return { id: item.id, deletedAt: item.updatedAt };
}

/**
 * Restore reuses `fields.manage` — no `recycleBin.restore` key is minted, and
 * a collision refuses rather than offers a rename. Renaming on restore is how
 * every other Bin entity resolves a collision, but `value` is the one field
 * this module's own PUT refuses to change; letting a restore change it would
 * be the sole loophole in that rule.
 */
export async function restoreValue(id: string, actor: ActorContext): Promise<OptionListItem> {
  requirePermission(actor, 'fields.manage');

  const existing = await customFieldRepo.findOptionById(actor.tenantId, id, { includeDeleted: true });
  if (!existing) throw new NotFoundError('Option');
  if (!existing.deletedAt) return existing;

  if (await customFieldRepo.isOptionValueTaken(actor.tenantId, existing.listKey, existing.value, id)) {
    throw new ConflictError(
      'error.conflict.optionValueTaken',
      { value: existing.value },
      { field: 'value', value: existing.value },
    );
  }

  await db().transaction(async (trx) => {
    await customFieldRepo.restoreOption(actor.tenantId, id, trx);

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'option_list_item',
        entityId: id,
        action: 'restored',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { name: existing.label, listKey: existing.listKey, value: existing.value },
      },
      actor,
      trx,
    );
  });

  customFieldRepo.invalidateFieldCache(actor.tenantId);

  const item = await customFieldRepo.findOptionById(actor.tenantId, id);
  if (!item) throw new NotFoundError('Option');

  publishChange({ entity: 'option_list', action: 'restored', id, payload: item });
  return item;
}

export async function reorderValues(
  input: OptionListReorderInput,
  actor: ActorContext,
): Promise<OptionListItem[]> {
  requirePermission(actor, 'fields.manage');

  const listKey = assertListKey(input.listKey);
  const live = await customFieldRepo.listOptionsForKey(actor.tenantId, listKey);
  const liveIds = live.map((item) => item.id);

  assertCompleteReorder(input.ids ?? [], liveIds, { listKey });

  await db().transaction(async (trx) => {
    await customFieldRepo.reorderOptions(actor.tenantId, resequence(input.ids), trx);

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'option_list_item',
        entityId: listKey,
        action: 'reordered',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { list: listKey },
      },
      actor,
      trx,
    );
  });

  customFieldRepo.invalidateFieldCache(actor.tenantId);

  const items = await customFieldRepo.listOptionsForKey(actor.tenantId, listKey);
  publishChange({ entity: 'option_list', action: 'updated', id: listKey, payload: items });
  return items;
}

// --- Custom-field definitions: fields.manage --------------------------------

export async function createDefinition(
  input: CustomFieldDefinitionInput,
  actor: ActorContext,
): Promise<CustomFieldDefinition> {
  requirePermission(actor, 'fields.manage');

  const entity = assertEntity(input.entity);
  const key = input.key?.trim();
  if (!key) throw new ValidationError('validation.fields.keyRequired', {}, { field: 'key' });

  const label = input.label?.trim() || key;
  assertFieldType(input.fieldType);

  const options = input.options ?? [];
  if (input.fieldType === 'select' && options.length === 0) {
    throw new ValidationError('validation.fields.optionsRequired', {}, { field: 'options' });
  }

  if (await customFieldRepo.isDefinitionKeyTaken(actor.tenantId, entity, key, null)) {
    throw new ConflictError('error.conflict.definitionKeyTaken', { key }, { field: 'key', value: key });
  }

  const sequence =
    input.sequence ?? (await customFieldRepo.definitionsFor(actor.tenantId, entity)).length + 1;

  const id = await db().transaction(async (trx) => {
    const insertedId = await customFieldRepo.insertDefinition(
      {
        tenantId: actor.tenantId,
        entity,
        key,
        label,
        fieldType: input.fieldType,
        isRequired: input.isRequired ?? false,
        options,
        sequence,
      },
      trx,
    );

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'custom_field_definition',
        entityId: insertedId,
        action: 'created',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { name: label, entity, key },
      },
      actor,
      trx,
    );

    return insertedId;
  });

  customFieldRepo.invalidateFieldCache(actor.tenantId);

  const definition = await customFieldRepo.findDefinitionById(actor.tenantId, id);
  if (!definition) throw new Error('Custom field disappeared immediately after insert');

  publishChange({ entity: 'custom_field', action: 'created', id: definition.id, payload: definition });
  return definition;
}

function assertFieldType(value: unknown): void {
  if (value !== 'text' && value !== 'number' && value !== 'date' && value !== 'select' && value !== 'boolean') {
    throw new ValidationError('validation.fields.fieldTypeInvalid', {}, {
      field: 'fieldType',
      allowed: ['text', 'number', 'date', 'select', 'boolean'],
    });
  }
}

export async function updateDefinition(
  id: string,
  input: CustomFieldDefinitionUpdateInput,
  actor: ActorContext,
): Promise<CustomFieldDefinition> {
  requirePermission(actor, 'fields.manage');
  assertNoImmutableFields(input, ['key', 'entity']);

  const existing = await customFieldRepo.findDefinitionById(actor.tenantId, id);
  if (!existing) throw new NotFoundError('Custom field');

  assertVersionMatches(
    existing.version,
    input.expectedVersion,
    fieldDiff(
      { label: existing.label, isRequired: existing.isRequired, options: existing.options, isActive: existing.isActive },
      { label: input.label, isRequired: input.isRequired, options: input.options, isActive: input.isActive },
    ),
  );

  if (input.options !== undefined && existing.fieldType === 'select' && input.options.length === 0) {
    throw new ValidationError('validation.fields.optionsRequired', {}, { field: 'options' });
  }

  await db().transaction(async (trx) => {
    await customFieldRepo.updateDefinitionColumns(
      actor.tenantId,
      id,
      {
        label: input.label?.trim() || undefined,
        isRequired: input.isRequired,
        options: input.options,
        isActive: input.isActive,
      },
      trx,
    );

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'custom_field_definition',
        entityId: id,
        action: 'updated',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { name: input.label ?? existing.label },
      },
      actor,
      trx,
    );
  });

  customFieldRepo.invalidateFieldCache(actor.tenantId);

  const definition = await customFieldRepo.findDefinitionById(actor.tenantId, id);
  if (!definition) throw new NotFoundError('Custom field');

  publishChange({ entity: 'custom_field', action: 'updated', id, payload: definition });
  return definition;
}

export async function deleteDefinition(
  id: string,
  actor: ActorContext,
): Promise<{ id: string; deletedAt: string }> {
  requirePermission(actor, 'fields.manage');

  const existing = await customFieldRepo.findDefinitionById(actor.tenantId, id);
  if (!existing) throw new NotFoundError('Custom field');

  await db().transaction(async (trx) => {
    await customFieldRepo.softDeleteDefinition(actor.tenantId, id, actorUserId(actor), trx);

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'custom_field_definition',
        entityId: id,
        action: 'deleted',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { name: existing.label, entity: existing.entity, key: existing.key },
      },
      actor,
      trx,
    );
  });

  customFieldRepo.invalidateFieldCache(actor.tenantId);

  const definition = await customFieldRepo.findDefinitionById(actor.tenantId, id, { includeDeleted: true });
  if (!definition) throw new NotFoundError('Custom field');

  publishChange({ entity: 'custom_field', action: 'deleted', id, payload: definition });
  return { id: definition.id, deletedAt: definition.deletedAt ?? new Date(0).toISOString() };
}

/** See `restoreValue` — the same "no rename on restore" reasoning applies to `key`. */
export async function restoreDefinition(id: string, actor: ActorContext): Promise<CustomFieldDefinition> {
  requirePermission(actor, 'fields.manage');

  const existing = await customFieldRepo.findDefinitionById(actor.tenantId, id, { includeDeleted: true });
  if (!existing) throw new NotFoundError('Custom field');
  if (!existing.deletedAt) return existing;

  if (await customFieldRepo.isDefinitionKeyTaken(actor.tenantId, existing.entity, existing.key, id)) {
    throw new ConflictError(
      'error.conflict.definitionKeyTaken',
      { key: existing.key },
      { field: 'key', value: existing.key },
    );
  }

  await db().transaction(async (trx) => {
    await customFieldRepo.restoreDefinition(actor.tenantId, id, trx);

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'custom_field_definition',
        entityId: id,
        action: 'restored',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { name: existing.label, entity: existing.entity, key: existing.key },
      },
      actor,
      trx,
    );
  });

  customFieldRepo.invalidateFieldCache(actor.tenantId);

  const definition = await customFieldRepo.findDefinitionById(actor.tenantId, id);
  if (!definition) throw new NotFoundError('Custom field');

  publishChange({ entity: 'custom_field', action: 'restored', id, payload: definition });
  return definition;
}

export async function reorderDefinitions(
  input: CustomFieldReorderInput,
  actor: ActorContext,
): Promise<CustomFieldDefinition[]> {
  requirePermission(actor, 'fields.manage');

  const entity = assertEntity(input.entity);
  const live = await customFieldRepo.definitionsFor(actor.tenantId, entity);
  const liveIds = live.map((definition) => definition.id);

  assertCompleteReorder(input.ids ?? [], liveIds, { entity });

  await db().transaction(async (trx) => {
    await customFieldRepo.reorderDefinitions(actor.tenantId, resequence(input.ids), trx);

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'custom_field_definition',
        entityId: entity,
        action: 'reordered',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { entity },
      },
      actor,
      trx,
    );
  });

  customFieldRepo.invalidateFieldCache(actor.tenantId);

  const definitions = await customFieldRepo.definitionsFor(actor.tenantId, entity);
  publishChange({ entity: 'custom_field', action: 'updated', id: entity, payload: definitions });
  return definitions;
}

// --- Pipeline stages: fields.manage ------------------------------------------

async function findStageOrThrow(tenantId: string, id: string): Promise<PipelineStage> {
  const stage = await pipelineRepo.findStageById(tenantId, id);
  if (!stage) throw new NotFoundError('Stage');
  return stage;
}

export async function updateStage(
  id: string,
  input: PipelineStageInput,
  actor: ActorContext,
): Promise<PipelineStage> {
  requirePermission(actor, 'fields.manage');

  const existing = await findStageOrThrow(actor.tenantId, id);
  const colour = input.colourHex === undefined ? undefined : assertHexColour(input.colourHex, 'colourHex');
  const name = input.name?.trim();

  await db().transaction(async (trx) => {
    await pipelineRepo.updateStageColumns(
      id,
      { name: name || undefined, colour, isTerminal: input.isTerminal },
      trx,
    );

    if (input.isDefault) {
      await pipelineRepo.setDefaultStage(existing.pipelineId, id, trx);
    }

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'pipeline_stage',
        entityId: id,
        action: input.isDefault ? 'default_changed' : 'updated',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { name: name || existing.name, pipeline: existing.pipelineId },
      },
      actor,
      trx,
    );
  });

  invalidateAfterStageWrite(actor.tenantId);

  const stage = await findStageOrThrow(actor.tenantId, id);
  publishChange({ entity: 'pipeline', action: 'updated', id, payload: stage });
  return stage;
}

export async function reorderStages(
  input: StageReorderInput,
  actor: ActorContext,
): Promise<PipelineStage[]> {
  requirePermission(actor, 'fields.manage');

  const liveIds = await pipelineRepo.liveStageIds(actor.tenantId, input.pipelineId);
  assertCompleteReorder(input.ids ?? [], liveIds, { pipelineId: input.pipelineId });

  await db().transaction(async (trx) => {
    await pipelineRepo.reorderStages(resequence(input.ids), trx);

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'pipeline_stage',
        entityId: input.pipelineId,
        action: 'reordered',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { pipeline: input.pipelineId },
      },
      actor,
      trx,
    );
  });

  invalidateAfterStageWrite(actor.tenantId);

  const stages = await stagesOfPipeline(actor.tenantId, input.pipelineId);
  publishChange({ entity: 'pipeline', action: 'updated', id: input.pipelineId, payload: stages });
  return stages;
}

export async function archiveStage(id: string, actor: ActorContext): Promise<PipelineStage> {
  requirePermission(actor, 'fields.manage');

  const existing = await findStageOrThrow(actor.tenantId, id);
  if (existing.isDefault) {
    throw new ConflictError('error.conflict.stageIsDefault', {}, { field: 'isDefault' });
  }

  await db().transaction(async (trx) => {
    const occupancy = await pipelineRepo.stageOccupancy(actor.tenantId, id, trx);
    if (occupancy.leads > 0 || occupancy.orders > 0) {
      const pipelines = await pipelineRepo.listPipelines(actor.tenantId, trx);
      const pipeline = pipelines.find((candidate) => candidate.id === existing.pipelineId);
      const suggestedTarget = pipeline?.stages.find((stage) => stage.isDefault)?.id ?? null;

      throw new ConflictError(
        'error.conflict.stageOccupied',
        {},
        { occupiedBy: occupancy, suggestedTarget },
      );
    }

    await pipelineRepo.archiveStage(id, trx);

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'pipeline_stage',
        entityId: id,
        action: 'archived',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { name: existing.name, pipeline: existing.pipelineId },
      },
      actor,
      trx,
    );
  });

  invalidateAfterStageWrite(actor.tenantId);

  const stage = await findStageOrThrow(actor.tenantId, id);
  publishChange({ entity: 'pipeline', action: 'updated', id, payload: stage });
  return stage;
}

export async function restoreStage(id: string, actor: ActorContext): Promise<PipelineStage> {
  requirePermission(actor, 'fields.manage');

  const existing = await findStageOrThrow(actor.tenantId, id);

  await db().transaction(async (trx) => {
    await pipelineRepo.restoreStage(id, trx);

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'pipeline_stage',
        entityId: id,
        action: 'restored',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { name: existing.name, pipeline: existing.pipelineId },
      },
      actor,
      trx,
    );
  });

  invalidateAfterStageWrite(actor.tenantId);

  const stage = await findStageOrThrow(actor.tenantId, id);
  publishChange({ entity: 'pipeline', action: 'updated', id, payload: stage });
  return stage;
}

async function stagesOfPipeline(tenantId: string, pipelineId: string): Promise<PipelineStage[]> {
  const pipelines = await pipelineRepo.listPipelines(tenantId);
  return pipelines.find((pipeline) => pipeline.id === pipelineId)?.stages ?? [];
}

function invalidateAfterStageWrite(tenantId: string): void {
  pipelineRepo.invalidatePipelineCache(tenantId);
}
