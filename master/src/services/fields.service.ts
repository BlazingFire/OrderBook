/**
 * Fields — every use case (`docs/backend-modules/06-WORKFLOWS.md` §5.1).
 *
 * Reads open with `fields.view` (no tier ceiling); writes open with
 * `fields.manage` (management+) — the first enforcement sites either key has
 * ever had. Every write is one transaction containing the row change and
 * `recordActivity`, then cache invalidation, then `publishChange` using the
 * already-declared `ChangedEntity` values `'option_list' | 'custom_field' |
 * 'pipeline'`.
 *
 * The three existing reads — `GET /api/pipelines`, `/api/option-lists`,
 * `/api/custom-fields` — are deliberately left alone by this module
 * (`fields.service.ts` exports an *unguarded* pair for them); routing them
 * through `fields.view` would make `buildSnapshot`'s `Promise.all` reject
 * for anyone lacking the key, and a rejected `buildSnapshot` produces no
 * snapshot at all.
 */

import type {
  CustomFieldDefinition,
  CustomFieldDefinitionInput,
  CustomFieldDefinitionUpdateInput,
  CustomFieldEntity,
  CustomFieldReorderInput,
  FieldCatalogue,
  FieldListKey,
  FieldUsageBreakdown,
  OptionListItem,
  OptionListItemInput,
  OptionListItemUpdateInput,
  OptionListReorderInput,
  Pipeline,
  PipelineStage,
  PipelineStageInput,
  StageReorderInput,
} from '@orderbook/shared';
import { buildFieldCatalogue, isFieldListKey } from '@orderbook/shared';

import { randomUUID } from 'node:crypto';

import { actorUserId, requirePermission, type ActorContext } from '../domain/actor.js';
import { assertVersionMatches, fieldDiff } from '../domain/access.js';
import {
  assertCompleteReorder,
  assertHexColour,
  normaliseOptionValue,
} from '../domain/field-values.js';
import { db } from '../db/knex.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import * as activityLog from '../repositories/activity-log.repository.js';
import * as fieldRepo from '../repositories/custom-field.repository.js';
import * as usageRepo from '../repositories/field-usage.repository.js';
import * as pipelineRepo from '../repositories/pipeline.repository.js';
import { publishChange } from './change-bus.js';

const CUSTOM_FIELD_ENTITIES: readonly CustomFieldEntity[] = ['lead', 'order', 'party', 'product'];

function assertListKey(value: unknown): FieldListKey {
  if (!isFieldListKey(value)) {
    throw new ValidationError('validation.fields.listKey.unknown', {}, {
      field: 'listKey',
      allowed: ['lead.sourcePlatform', 'stock.colour', 'product.productType', 'line.packaging'],
    });
  }
  return value;
}

function assertEntity(value: unknown): CustomFieldEntity {
  if (typeof value !== 'string' || !CUSTOM_FIELD_ENTITIES.includes(value as CustomFieldEntity)) {
    throw new ValidationError('validation.fields.entity.unknown', {}, {
      field: 'entity',
      allowed: CUSTOM_FIELD_ENTITIES,
    });
  }
  return value as CustomFieldEntity;
}

// --- Unguarded reads for the three existing endpoints -----------------------
// `GET /api/pipelines`, `/api/option-lists`, `/api/custom-fields` stay behind
// `requireAuth` only — see the file header.

export async function listPipelinesUnguarded(tenantId: string): Promise<Pipeline[]> {
  return pipelineRepo.listPipelines(tenantId);
}

export async function listOptionListsUnguarded(tenantId: string): Promise<OptionListItem[]> {
  return fieldRepo.listOptions(tenantId);
}

export async function listCustomFieldsUnguarded(tenantId: string): Promise<CustomFieldDefinition[]> {
  return fieldRepo.listDefinitions(tenantId);
}

// --- The gated /api/fields/* surface ----------------------------------------

/** `async` for a uniform Promise-returning shape across every export the socket hub's `run()` dispatches to. */
export async function fieldsCatalogue(actor: ActorContext): Promise<FieldCatalogue> {
  requirePermission(actor, 'fields.view');
  return buildFieldCatalogue();
}

export async function listValues(
  query: { listKey: unknown; includeDeleted?: boolean; includeUnlisted?: boolean },
  actor: ActorContext,
): Promise<{ items: OptionListItem[]; unlisted?: string[] }> {
  requirePermission(actor, 'fields.view');
  const listKey = assertListKey(query.listKey);

  const items = await fieldRepo.optionValuesForKey(actor.tenantId, listKey, {
    includeDeleted: query.includeDeleted,
  });

  if (!query.includeUnlisted) return { items };

  const breakdown = await usageRepo.usageForListKey(actor.tenantId, listKey);
  return { items, unlisted: breakdown.unlisted.map((usage) => usage.value) };
}

export async function fieldUsage(
  query: { listKey: unknown },
  actor: ActorContext,
): Promise<FieldUsageBreakdown> {
  requirePermission(actor, 'fields.view');
  const listKey = assertListKey(query.listKey);
  return usageRepo.usageForListKey(actor.tenantId, listKey);
}

export async function listDefinitions(
  query: { entity?: unknown; includeDeleted?: boolean },
  actor: ActorContext,
): Promise<CustomFieldDefinition[]> {
  requirePermission(actor, 'fields.view');
  const all = await fieldRepo.listDefinitions(actor.tenantId, { includeDeleted: Boolean(query.includeDeleted) });

  const entity = query.entity === undefined ? undefined : assertEntity(query.entity);
  return all.filter((definition) => entity === undefined || definition.entity === entity);
}

export async function listStages(actor: ActorContext): Promise<Pipeline[]> {
  requirePermission(actor, 'fields.view');
  return pipelineRepo.listPipelines(actor.tenantId);
}

// --- Option-list values -------------------------------------------------

export async function createValue(input: OptionListItemInput, actor: ActorContext): Promise<OptionListItem> {
  requirePermission(actor, 'fields.manage');
  const listKey = assertListKey(input.listKey);

  const value = normaliseOptionValue(input.value ?? '');
  if (!value) throw new ValidationError('validation.fields.value.required', {}, { field: 'value' });

  const label = (input.label ?? '').trim() || value;
  const hex = input.hex ? assertHexColour(input.hex) : null;

  if (await fieldRepo.isOptionValueTaken(actor.tenantId, listKey, value, undefined)) {
    throw new ConflictError('error.conflict.optionValueTaken', {}, { field: 'value', value });
  }

  const siblingCount = (await fieldRepo.optionValuesForKey(actor.tenantId, listKey)).length;
  const id = randomUUID();

  const item = await db().transaction(async (trx) => {
    const row = await fieldRepo.insertOptionListItem(
      actor.tenantId,
      { id, listKey, value, label, hex, sequence: input.sequence ?? siblingCount + 1 },
      trx,
    );

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'option_list_item',
        entityId: id,
        action: 'created',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { name: label, listKey },
      },
      actor,
      trx,
    );

    return row;
  });

  fieldRepo.invalidateFieldCache(actor.tenantId);
  publishChange({ entity: 'option_list', action: 'created', id, payload: item });
  return item;
}

export async function updateValue(
  id: string,
  input: OptionListItemUpdateInput,
  actor: ActorContext,
): Promise<OptionListItem> {
  requirePermission(actor, 'fields.manage');

  const hex = input.hex === undefined || input.hex === null ? input.hex : assertHexColour(input.hex);

  const item = await db().transaction(async (trx) => {
    const existing = await fieldRepo.lockOptionListItem(actor.tenantId, id, trx);
    if (!existing || existing.deletedAt) throw new NotFoundError('Option');

    assertVersionMatches(
      existing.version,
      input.expectedVersion,
      fieldDiff(
        { label: existing.label, hex: existing.hex, isActive: existing.isActive },
        { label: input.label, hex, isActive: input.isActive },
      ),
    );

    const row = await fieldRepo.updateOptionListItem(
      actor.tenantId,
      id,
      { label: input.label, hex, isActive: input.isActive },
      trx,
    );
    if (!row) throw new NotFoundError('Option');

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'option_list_item',
        entityId: id,
        action: 'updated',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { name: row.label, listKey: row.listKey },
      },
      actor,
      trx,
    );

    return row;
  });

  fieldRepo.invalidateFieldCache(actor.tenantId);
  publishChange({ entity: 'option_list', action: 'updated', id, payload: item });
  return item;
}

export async function removeValue(id: string, actor: ActorContext): Promise<{ id: string; deletedAt: string }> {
  requirePermission(actor, 'fields.manage');

  const item = await db().transaction(async (trx) => {
    const existing = await fieldRepo.lockOptionListItem(actor.tenantId, id, trx);
    if (!existing || existing.deletedAt) throw new NotFoundError('Option');

    const row = await fieldRepo.softDeleteOptionListItem(actor.tenantId, id, actorUserId(actor), trx);
    if (!row) throw new NotFoundError('Option');

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'option_list_item',
        entityId: id,
        action: 'deleted',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { name: row.label, listKey: row.listKey },
      },
      actor,
      trx,
    );

    return row;
  });

  fieldRepo.invalidateFieldCache(actor.tenantId);
  publishChange({ entity: 'option_list', action: 'deleted', id, payload: item });
  return { id, deletedAt: item.deletedAt ?? new Date().toISOString() };
}

export async function reorderValues(
  input: OptionListReorderInput,
  actor: ActorContext,
): Promise<OptionListItem[]> {
  requirePermission(actor, 'fields.manage');
  const listKey = assertListKey(input.listKey);

  const current = await fieldRepo.optionValuesForKey(actor.tenantId, listKey);
  assertCompleteReorder(current.map((item) => item.id), input.ids);

  const items = await db().transaction(async (trx) => {
    await fieldRepo.reorderOptionListItems(actor.tenantId, input.ids, trx);

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'option_list_item',
        entityId: listKey,
        action: 'updated',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { listKey, reordered: true },
      },
      actor,
      trx,
    );

    return fieldRepo.optionValuesForKey(actor.tenantId, listKey, {}, trx);
  });

  fieldRepo.invalidateFieldCache(actor.tenantId);
  publishChange({ entity: 'option_list', action: 'updated', id: listKey, payload: items });
  return items;
}

// --- Custom-field definitions -------------------------------------------

export async function createDefinition(
  input: CustomFieldDefinitionInput,
  actor: ActorContext,
): Promise<CustomFieldDefinition> {
  requirePermission(actor, 'fields.manage');
  const entity = assertEntity(input.entity);

  const key = (input.key ?? '').trim();
  if (!key) throw new ValidationError('validation.fields.key.required', {}, { field: 'key' });

  const label = (input.label ?? '').trim() || key;
  const fieldType = assertFieldType(input.fieldType);

  const options = input.options ?? [];
  if (fieldType === 'select' && options.length === 0) {
    throw new ValidationError('validation.fields.options.required', {}, { field: 'options' });
  }

  if (await fieldRepo.isDefinitionKeyTaken(actor.tenantId, entity, key, undefined)) {
    throw new ConflictError('error.conflict.customFieldKeyTaken', {}, { field: 'key', value: key });
  }

  const siblingCount = (await fieldRepo.definitionsFor(actor.tenantId, entity)).length;
  const id = randomUUID();

  const definition = await db().transaction(async (trx) => {
    const row = await fieldRepo.insertDefinition(
      actor.tenantId,
      {
        id,
        entity,
        key,
        label,
        fieldType,
        isRequired: input.isRequired ?? false,
        options,
        sequence: input.sequence ?? siblingCount + 1,
      },
      trx,
    );

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'custom_field_definition',
        entityId: id,
        action: 'created',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { name: label, entity },
      },
      actor,
      trx,
    );

    return row;
  });

  fieldRepo.invalidateFieldCache(actor.tenantId);
  publishChange({ entity: 'custom_field', action: 'created', id, payload: definition });
  return definition;
}

export async function updateDefinition(
  id: string,
  input: CustomFieldDefinitionUpdateInput,
  actor: ActorContext,
): Promise<CustomFieldDefinition> {
  requirePermission(actor, 'fields.manage');

  const definition = await db().transaction(async (trx) => {
    const existing = await fieldRepo.lockDefinition(actor.tenantId, id, trx);
    if (!existing || existing.deletedAt) throw new NotFoundError('Custom field');

    if (existing.fieldType === 'select' && input.options && input.options.length === 0) {
      throw new ValidationError('validation.fields.options.required', {}, { field: 'options' });
    }

    assertVersionMatches(
      existing.version,
      input.expectedVersion,
      fieldDiff(
        { label: existing.label, isRequired: existing.isRequired, options: existing.options, isActive: existing.isActive },
        { label: input.label, isRequired: input.isRequired, options: input.options, isActive: input.isActive },
      ),
    );

    const row = await fieldRepo.updateDefinition(
      actor.tenantId,
      id,
      { label: input.label, isRequired: input.isRequired, options: input.options, isActive: input.isActive },
      trx,
    );
    if (!row) throw new NotFoundError('Custom field');

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'custom_field_definition',
        entityId: id,
        action: 'updated',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { name: row.label, entity: row.entity },
      },
      actor,
      trx,
    );

    return row;
  });

  fieldRepo.invalidateFieldCache(actor.tenantId);
  publishChange({ entity: 'custom_field', action: 'updated', id, payload: definition });
  return definition;
}

export async function removeDefinition(
  id: string,
  actor: ActorContext,
): Promise<{ id: string; deletedAt: string }> {
  requirePermission(actor, 'fields.manage');

  const definition = await db().transaction(async (trx) => {
    const existing = await fieldRepo.lockDefinition(actor.tenantId, id, trx);
    if (!existing || existing.deletedAt) throw new NotFoundError('Custom field');

    const row = await fieldRepo.softDeleteDefinition(actor.tenantId, id, actorUserId(actor), trx);
    if (!row) throw new NotFoundError('Custom field');

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'custom_field_definition',
        entityId: id,
        action: 'deleted',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { name: row.label, entity: row.entity },
      },
      actor,
      trx,
    );

    return row;
  });

  fieldRepo.invalidateFieldCache(actor.tenantId);
  publishChange({ entity: 'custom_field', action: 'deleted', id, payload: definition });
  return { id, deletedAt: definition.deletedAt ?? new Date().toISOString() };
}

export async function reorderDefinitions(
  input: CustomFieldReorderInput,
  actor: ActorContext,
): Promise<CustomFieldDefinition[]> {
  requirePermission(actor, 'fields.manage');
  const entity = assertEntity(input.entity);

  const current = await fieldRepo.definitionsForEntity(actor.tenantId, entity);
  assertCompleteReorder(current.map((definition) => definition.id), input.ids);

  const definitions = await db().transaction(async (trx) => {
    await fieldRepo.reorderDefinitions(actor.tenantId, input.ids, trx);

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'custom_field_definition',
        entityId: entity,
        action: 'updated',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { entity, reordered: true },
      },
      actor,
      trx,
    );

    return fieldRepo.definitionsForEntity(actor.tenantId, entity, trx);
  });

  fieldRepo.invalidateFieldCache(actor.tenantId);
  publishChange({ entity: 'custom_field', action: 'updated', id: entity, payload: definitions });
  return definitions;
}

function assertFieldType(value: unknown): CustomFieldDefinition['fieldType'] {
  const allowed = ['text', 'number', 'date', 'select', 'boolean'] as const;
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ValidationError('validation.fields.fieldType.unknown', {}, { field: 'fieldType', allowed });
  }
  return value as CustomFieldDefinition['fieldType'];
}

// --- Pipeline stages ------------------------------------------------------

export async function updateStage(
  id: string,
  input: PipelineStageInput,
  actor: ActorContext,
): Promise<PipelineStage> {
  requirePermission(actor, 'fields.manage');

  const stage = await db().transaction(async (trx) => {
    const existing = await pipelineRepo.findStageById(actor.tenantId, id, trx);
    if (!existing) throw new NotFoundError('Stage');

    const name = input.name?.trim();
    if (input.name !== undefined && !name) {
      throw new ValidationError('validation.stage.required');
    }

    const colour = input.colourHex === undefined ? undefined : input.colourHex ? assertHexColour(input.colourHex) : null;

    const patch: { name?: string; colour?: string | null; is_terminal?: boolean } = {
      ...(name !== undefined ? { name } : {}),
      ...(colour !== undefined ? { colour } : {}),
      ...(input.isTerminal !== undefined ? { is_terminal: input.isTerminal } : {}),
    };

    // A caller setting only `isDefault` sends an otherwise-empty patch — an
    // empty `UPDATE` is a Knex error, not a no-op, so skip the column write
    // entirely rather than issuing one with nothing to set.
    let row =
      Object.keys(patch).length > 0
        ? await pipelineRepo.updateStageColumns(existing.pipelineId, id, patch, trx)
        : existing;

    if (input.isDefault) {
      await pipelineRepo.setDefaultStage(existing.pipelineId, id, trx);
      row = await pipelineRepo.findStageById(actor.tenantId, id, trx);
    }

    if (!row) throw new NotFoundError('Stage');

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'pipeline_stage',
        entityId: id,
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

  pipelineRepo.invalidatePipelineCache(actor.tenantId);
  publishChange({ entity: 'pipeline', action: 'updated', id, payload: stage });
  return stage;
}

export async function reorderStages(input: StageReorderInput, actor: ActorContext): Promise<PipelineStage[]> {
  requirePermission(actor, 'fields.manage');

  const currentIds = await pipelineRepo.stageIdsForPipeline(actor.tenantId, input.pipelineId);
  if (currentIds.length === 0) throw new NotFoundError('Pipeline');
  assertCompleteReorder(currentIds, input.ids);

  const stages = await db().transaction(async (trx) => {
    await pipelineRepo.reorderStagesDeferred(input.pipelineId, input.ids, trx);

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

    return pipelineRepo.stagesForPipelineFresh(actor.tenantId, input.pipelineId, trx);
  });

  pipelineRepo.invalidatePipelineCache(actor.tenantId);
  publishChange({ entity: 'pipeline', action: 'updated', id: input.pipelineId, payload: stages });
  return stages;
}

export async function archiveStage(id: string, actor: ActorContext): Promise<PipelineStage> {
  requirePermission(actor, 'fields.manage');

  const stage = await db().transaction(async (trx) => {
    const existing = await pipelineRepo.findStageById(actor.tenantId, id, trx);
    if (!existing) throw new NotFoundError('Stage');

    if (existing.isDefault) {
      throw new ValidationError('validation.fields.stage.archiveDefault', {}, { field: 'isDefault' });
    }

    const liveCount = await pipelineRepo.countLiveRecordsInStage(actor.tenantId, id, trx);
    if (liveCount > 0) {
      throw new ConflictError(
        liveCount === 1 ? 'validation.fields.stage.archiveBlocked.one' : 'validation.fields.stage.archiveBlocked.other',
        { count: liveCount },
        { count: liveCount },
      );
    }

    const row = await pipelineRepo.archiveStage(existing.pipelineId, id, trx);
    if (!row) throw new NotFoundError('Stage');

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'pipeline_stage',
        entityId: id,
        action: 'archived',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { name: row.name },
      },
      actor,
      trx,
    );

    return row;
  });

  pipelineRepo.invalidatePipelineCache(actor.tenantId);
  publishChange({ entity: 'pipeline', action: 'updated', id, payload: stage });
  return stage;
}

export async function restoreStage(id: string, actor: ActorContext): Promise<PipelineStage> {
  requirePermission(actor, 'fields.manage');

  const stage = await db().transaction(async (trx) => {
    const existing = await pipelineRepo.findStageById(actor.tenantId, id, trx);
    if (!existing) throw new NotFoundError('Stage');

    const row = await pipelineRepo.restoreStage(existing.pipelineId, id, trx);
    if (!row) throw new NotFoundError('Stage');

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'pipeline_stage',
        entityId: id,
        action: 'restored',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { name: row.name },
      },
      actor,
      trx,
    );

    return row;
  });

  pipelineRepo.invalidatePipelineCache(actor.tenantId);
  publishChange({ entity: 'pipeline', action: 'updated', id, payload: stage });
  return stage;
}

/**
 * Restore a soft-deleted option-list value or custom-field definition.
 *
 * Both existed in `custom-field.repository.ts` from Stage 3 and both entity
 * types were added to `RECYCLE_BIN_ENTITIES` — but no service function ever
 * called them and the Bin's `UNION` never grew a branch, so a deleted value
 * was listed nowhere and `restoreEntity` refused it as an "unknown entity
 * type" despite the type being in its own allowed list. These close that.
 */
export async function restoreOptionListItem(id: string, actor: ActorContext): Promise<OptionListItem> {
  requirePermission(actor, 'fields.manage');

  const item = await db().transaction(async (trx) => {
    const row = await fieldRepo.restoreOptionListItem(actor.tenantId, id, trx);
    if (!row) throw new NotFoundError('Option');

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'option_list_item',
        entityId: id,
        action: 'restored',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { name: row.label, listKey: row.listKey },
      },
      actor,
      trx,
    );

    return row;
  });

  fieldRepo.invalidateFieldCache(actor.tenantId);
  publishChange({ entity: 'option_list', action: 'restored', id, payload: item });
  return item;
}

export async function restoreCustomFieldDefinition(
  id: string,
  actor: ActorContext,
): Promise<CustomFieldDefinition> {
  requirePermission(actor, 'fields.manage');

  const definition = await db().transaction(async (trx) => {
    const row = await fieldRepo.restoreDefinition(actor.tenantId, id, trx);
    if (!row) throw new NotFoundError('Custom field');

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'custom_field_definition',
        entityId: id,
        action: 'restored',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { name: row.label },
      },
      actor,
      trx,
    );

    return row;
  });

  fieldRepo.invalidateFieldCache(actor.tenantId);
  publishChange({ entity: 'custom_field', action: 'restored', id, payload: definition });
  return definition;
}
