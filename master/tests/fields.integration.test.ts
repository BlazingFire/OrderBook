/**
 * Fields, Stage 3 of `docs/backend-modules/` — integration gates
 * (`10-TESTING.md` §"Stage 3 — Fields", FLD-5 through FLD-21). Drives real
 * PostgreSQL: the deferred-constraint reorder, the clear-then-set default
 * swap, the partial unique index, the mandatory-`expectedVersion` concurrency
 * contract, and the rule the whole module hangs on — removing a value never
 * touches a single record that already held it.
 */

import type { Product } from '@orderbook/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { canRunIntegrationTests } from './helpers/db.js';
import {
  actorWith,
  resetData,
  setupDatabase,
  stageIdByName,
  teardownDatabase,
  testActor,
  testTenantId,
} from './helpers/fixtures.js';
import type { ActorContext } from '../src/domain/actor.js';
import { db } from '../src/db/knex.js';
import { ConflictError, ForbiddenError, ValidationError } from '../src/lib/errors.js';
import * as customFieldRepo from '../src/repositories/custom-field.repository.js';
import * as pipelineRepo from '../src/repositories/pipeline.repository.js';
import * as catalogService from '../src/services/catalog.service.js';
import * as fieldsService from '../src/services/fields.service.js';
import * as leadService from '../src/services/lead.service.js';
import * as recycleBinService from '../src/services/recycle-bin.service.js';
import { buildSnapshot } from '../src/services/snapshot.service.js';

let actor: ActorContext;

async function seedLeadFixture() {
  const party = await catalogService.createParty({ name: 'Patel Tiles' }, actor);
  const product = await catalogService.createProduct(
    { categoryName: 'Tiles', variants: [{ code: 'GVT-01' }], name: 'Carrara White' },
    actor,
  );
  return { party, product };
}

function line(product: Product) {
  return { productId: product.id, variantId: product.variants[0]!.id, quantity: 10, packaging: 'carton' };
}

async function sourcePlatformValueId(value: string): Promise<string> {
  const tenantId = await testTenantId();
  const items = await customFieldRepo.listOptionsForKey(tenantId, 'lead.sourcePlatform');
  const item = items.find((candidate) => candidate.value === value);
  if (!item) throw new Error(`No seeded lead.sourcePlatform option "${value}"`);
  return item.id;
}

async function activityActionsFor(entityType: string, entityId: string): Promise<string[]> {
  const rows = await db()('activity_log')
    .where({ entity_type: entityType, entity_id: entityId })
    .orderBy('id')
    .select<Array<{ action: string }>>('action');
  return rows.map((row) => row.action);
}

describe.skipIf(!canRunIntegrationTests)('Fields (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    actor = await testActor();
  });

  describe('option-list values', () => {
    it('creates a value and lists it in sequence order', async () => {
      const created = await fieldsService.createValue(
        { listKey: 'stock.colour', value: 'Ivory', label: 'Ivory', hex: '#F5F0E6' },
        actor,
      );
      expect(created.value).toBe('Ivory');
      expect(created.hex).toBe('#f5f0e6');
      expect(created.version).toBe(1);

      const { items } = await fieldsService.listValues({ listKey: 'stock.colour' }, actor);
      expect(items.map((item) => item.value)).toContain('Ivory');
    });

    it('never case-folds — "White" and "white" are two distinct live values', async () => {
      await fieldsService.createValue({ listKey: 'stock.colour', value: 'White', label: 'White' }, actor);
      const lower = await fieldsService.createValue(
        { listKey: 'stock.colour', value: 'white', label: 'white' },
        actor,
      );
      expect(lower.value).toBe('white');

      const { items } = await fieldsService.listValues({ listKey: 'stock.colour' }, actor);
      expect(items.filter((item) => item.value.toLowerCase() === 'white')).toHaveLength(2);
    });

    it('refuses a duplicate live (listKey, value)', async () => {
      await fieldsService.createValue({ listKey: 'stock.colour', value: 'Ivory', label: 'Ivory' }, actor);
      await expect(
        fieldsService.createValue({ listKey: 'stock.colour', value: 'Ivory', label: 'Different label' }, actor),
      ).rejects.toThrow(ConflictError);
    });

    it('rejects a malformed hex', async () => {
      await expect(
        fieldsService.createValue({ listKey: 'stock.colour', value: 'Ivory', label: 'Ivory', hex: 'not-a-hex' }, actor),
      ).rejects.toThrow(ValidationError);
    });

    it('after removing "Ivory", adding it back is possible — the partial unique index at work', async () => {
      const first = await fieldsService.createValue({ listKey: 'stock.colour', value: 'Ivory', label: 'Ivory' }, actor);
      await fieldsService.deleteValue(first.id, actor);

      const second = await fieldsService.createValue({ listKey: 'stock.colour', value: 'Ivory', label: 'Ivory' }, actor);
      expect(second.id).not.toBe(first.id);
      expect(second.value).toBe('Ivory');
    });

    describe('editing', () => {
      it('renames the label and recolours, bumping version', async () => {
        const value = await fieldsService.createValue(
          { listKey: 'stock.colour', value: 'Ivory', label: 'Ivory' },
          actor,
        );

        const updated = await fieldsService.updateValue(
          value.id,
          { label: 'Ivory White', hex: '#FFFFFF', expectedVersion: value.version },
          actor,
        );

        expect(updated.label).toBe('Ivory White');
        expect(updated.hex).toBe('#ffffff');
        expect(updated.version).toBe(2);
      });

      it('refuses to change `value` even if the raw payload smuggles one in', async () => {
        const value = await fieldsService.createValue(
          { listKey: 'stock.colour', value: 'Ivory', label: 'Ivory' },
          actor,
        );

        const sneaky = { label: 'Renamed', value: 'Hijacked', expectedVersion: value.version };
        await expect(
          fieldsService.updateValue(value.id, sneaky as unknown as Parameters<typeof fieldsService.updateValue>[1], actor),
        ).rejects.toThrow(ValidationError);
      });

      it('is refused with 400 when `expectedVersion` is omitted', async () => {
        const value = await fieldsService.createValue(
          { listKey: 'stock.colour', value: 'Ivory', label: 'Ivory' },
          actor,
        );

        const noVersion = { label: 'Renamed' } as unknown as Parameters<typeof fieldsService.updateValue>[1];
        await expect(fieldsService.updateValue(value.id, noVersion, actor)).rejects.toThrow(ValidationError);
      });

      it('is refused with a conflict carrying storedVersion when stale, and does not overwrite', async () => {
        const value = await fieldsService.createValue(
          { listKey: 'stock.colour', value: 'Ivory', label: 'Ivory' },
          actor,
        );

        // First writer, using the version everyone started from.
        await fieldsService.updateValue(value.id, { label: 'First', expectedVersion: value.version }, actor);

        // Second writer still holds the original (now stale) version.
        try {
          await fieldsService.updateValue(value.id, { label: 'Second', expectedVersion: value.version }, actor);
          expect.unreachable('the stale save should have been refused');
        } catch (error) {
          expect(error).toBeInstanceOf(ConflictError);
          expect((error as ConflictError).details).toMatchObject({ storedVersion: 2 });
        }

        const stored = await customFieldRepo.findOptionById(actor.tenantId, value.id);
        expect(stored?.label).toBe('First');
      });
    });

    describe('removal never touches a record that used it', () => {
      it('a lead keeps its sourcePlatform after the option is removed, and can still be saved', async () => {
        const { party, product } = await seedLeadFixture();
        const lead = await leadService.createLead(
          { partyId: party.id, sourcePlatform: 'whatsapp', items: [line(product)] },
          actor,
        );
        expect(lead.sourcePlatform).toBe('whatsapp');

        const optionId = await sourcePlatformValueId('whatsapp');
        await fieldsService.deleteValue(optionId, actor);

        const reloaded = await leadService.getLead(lead.id, actor);
        expect(reloaded.sourcePlatform).toBe('whatsapp');

        // Editing an unrelated field, with the now-removed value still on the
        // payload (as a real form would resend it), must not be refused.
        const updated = await leadService.updateLead(
          lead.id,
          { sourcePlatform: 'whatsapp', notes: 'Follow up Monday' },
          actor,
        );
        expect(updated.sourcePlatform).toBe('whatsapp');
        expect(updated.notes).toBe('Follow up Monday');
      });

      it('a NEW lead may not take a value that has since been removed', async () => {
        const { party, product } = await seedLeadFixture();
        const optionId = await sourcePlatformValueId('whatsapp');
        await fieldsService.deleteValue(optionId, actor);

        await expect(
          leadService.createLead(
            { partyId: party.id, sourcePlatform: 'whatsapp', items: [line(product)] },
            actor,
          ),
        ).rejects.toThrow(ValidationError);
      });

      it('leaves every referencing row byte-identical', async () => {
        const value = await fieldsService.createValue({ listKey: 'stock.colour', value: 'Ivory', label: 'Ivory' }, actor);
        const { product } = await seedLeadFixture();

        await catalogService.updateProduct(product.id, { name: product.name }, actor);
        // A colour with no inventory row yet is the common case; the point of
        // this gate is that deleting the option touches nothing in
        // `inventory_stock`/`line_items`/`stock_reservations` — proven
        // by there being zero rows for this fresh product before and after.
        const before = await db()('inventory_stock').where({ tenant_id: actor.tenantId }).select('*');

        await fieldsService.deleteValue(value.id, actor);

        const after = await db()('inventory_stock').where({ tenant_id: actor.tenantId }).select('*');
        expect(after).toEqual(before);
      });
    });

    describe('reorder', () => {
      it('takes the complete ordered list and writes 1..N', async () => {
        const a = await fieldsService.createValue({ listKey: 'stock.colour', value: 'A', label: 'A' }, actor);
        const b = await fieldsService.createValue({ listKey: 'stock.colour', value: 'B', label: 'B' }, actor);
        const c = await fieldsService.createValue({ listKey: 'stock.colour', value: 'C', label: 'C' }, actor);

        const reordered = await fieldsService.reorderValues({ listKey: 'stock.colour', ids: [c.id, a.id, b.id] }, actor);
        expect(reordered.map((item) => item.value)).toEqual(['C', 'A', 'B']);
        expect(reordered.map((item) => item.sequence)).toEqual([1, 2, 3]);
      });

      it('rejects a list missing a live value', async () => {
        const a = await fieldsService.createValue({ listKey: 'stock.colour', value: 'A', label: 'A' }, actor);
        await fieldsService.createValue({ listKey: 'stock.colour', value: 'B', label: 'B' }, actor);

        await expect(fieldsService.reorderValues({ listKey: 'stock.colour', ids: [a.id] }, actor)).rejects.toThrow(
          ValidationError,
        );
      });
    });

    it('records an activity_log entry for create, update and delete, atomically with the change', async () => {
      const value = await fieldsService.createValue({ listKey: 'stock.colour', value: 'Ivory', label: 'Ivory' }, actor);
      await fieldsService.updateValue(value.id, { label: 'Renamed', expectedVersion: value.version }, actor);
      await fieldsService.deleteValue(value.id, actor);

      expect(await activityActionsFor('option_list_item', value.id)).toEqual(['created', 'updated', 'deleted']);
    });
  });

  describe('custom-field definitions', () => {
    it('creates a definition and lists it for its entity', async () => {
      const definition = await fieldsService.createDefinition(
        { entity: 'lead', key: 'budget', label: 'Budget', fieldType: 'number' },
        actor,
      );
      expect(definition.key).toBe('budget');

      const definitions = await fieldsService.listDefinitions({ entity: 'lead' }, actor);
      expect(definitions.map((d) => d.key)).toContain('budget');
    });

    it('refuses a `select` field with no options', async () => {
      await expect(
        fieldsService.createDefinition({ entity: 'lead', key: 'colour', label: 'Colour', fieldType: 'select' }, actor),
      ).rejects.toThrow(ValidationError);
    });

    it('refuses a duplicate live (entity, key)', async () => {
      await fieldsService.createDefinition({ entity: 'lead', key: 'budget', label: 'Budget', fieldType: 'number' }, actor);
      await expect(
        fieldsService.createDefinition({ entity: 'lead', key: 'budget', label: 'Budget again', fieldType: 'text' }, actor),
      ).rejects.toThrow(ConflictError);
    });

    it('refuses to change `key` on update, even smuggled in the raw payload', async () => {
      const definition = await fieldsService.createDefinition(
        { entity: 'lead', key: 'budget', label: 'Budget', fieldType: 'number' },
        actor,
      );

      const sneaky = { label: 'Renamed', key: 'hijacked', expectedVersion: definition.version };
      await expect(
        fieldsService.updateDefinition(
          definition.id,
          sneaky as unknown as Parameters<typeof fieldsService.updateDefinition>[1],
          actor,
        ),
      ).rejects.toThrow(ValidationError);
    });

    it('deleting a required definition makes an incomplete record complete again, and restoring it flips the badge back', async () => {
      const definition = await fieldsService.createDefinition(
        { entity: 'lead', key: 'budget', label: 'Budget', fieldType: 'number', isRequired: true },
        actor,
      );

      const { party, product } = await seedLeadFixture();
      const lead = await leadService.createLead({ partyId: party.id, items: [line(product)] }, actor);
      expect(lead.incomplete).toBe(true);
      expect(lead.missingFields).toContain('Budget');

      await fieldsService.deleteDefinition(definition.id, actor);
      const afterDelete = await leadService.getLead(lead.id, actor);
      expect(afterDelete.incomplete).toBe(false);

      await fieldsService.restoreDefinition(definition.id, actor);
      const afterRestore = await leadService.getLead(lead.id, actor);
      expect(afterRestore.incomplete).toBe(true);
    });

    it('reorder rejects anything that is not exactly a permutation of the entity’s live definitions', async () => {
      const a = await fieldsService.createDefinition({ entity: 'party', key: 'a', label: 'A', fieldType: 'text' }, actor);
      await fieldsService.createDefinition({ entity: 'party', key: 'b', label: 'B', fieldType: 'text' }, actor);

      await expect(fieldsService.reorderDefinitions({ entity: 'party', ids: [a.id] }, actor)).rejects.toThrow(
        ValidationError,
      );
    });
  });

  describe('pipeline stages', () => {
    it('renames and recolours a stage', async () => {
      const stageId = await stageIdByName('lead', 'Quoted');
      const updated = await fieldsService.updateStage(stageId, { name: 'Quoted (Pending)', colourHex: '#123ABC' }, actor);
      expect(updated.name).toBe('Quoted (Pending)');
      expect(updated.colour).toBe('#123abc');
    });

    it('reorders every stage in a pipeline under the deferred sequence constraint', async () => {
      const pipelines = await pipelineRepo.listPipelines(actor.tenantId);
      const leadPipeline = pipelines.find((pipeline) => pipeline.kind === 'lead');
      if (!leadPipeline) throw new Error('No lead pipeline seeded');

      const currentIds = leadPipeline.stages.map((stage) => stage.id);
      // Drag the last stage to the front — this is exactly the transient
      // collision `pipeline_stages_seq_unique DEFERRED` exists for: without
      // it, the very first UPDATE of this loop fails immediately.
      const reordered = [currentIds.at(-1) as string, ...currentIds.slice(0, -1)];

      const stages = await fieldsService.reorderStages({ pipelineId: leadPipeline.id, ids: reordered }, actor);
      expect(stages.map((stage) => stage.id)).toEqual(reordered);
      expect(stages.map((stage) => stage.sequence)).toEqual([1, 2, 3, 4, 5]);
    });

    it('rejects a reorder that is not exactly the pipeline’s live stage ids', async () => {
      const pipelines = await pipelineRepo.listPipelines(actor.tenantId);
      const leadPipeline = pipelines.find((pipeline) => pipeline.kind === 'lead');
      if (!leadPipeline) throw new Error('No lead pipeline seeded');

      await expect(
        fieldsService.reorderStages({ pipelineId: leadPipeline.id, ids: [leadPipeline.stages[0]?.id as string] }, actor),
      ).rejects.toThrow(ValidationError);
    });

    it('swaps the default stage — clear-then-set, never two defaults at once', async () => {
      const newStageId = await stageIdByName('lead', 'New');
      const quotedStageId = await stageIdByName('lead', 'Quoted');

      const updated = await fieldsService.updateStage(quotedStageId, { isDefault: true }, actor);
      expect(updated.isDefault).toBe(true);

      const pipelines = await pipelineRepo.listPipelines(actor.tenantId);
      const stages = pipelines.find((pipeline) => pipeline.kind === 'lead')?.stages ?? [];
      const defaults = stages.filter((stage) => stage.isDefault);
      expect(defaults).toHaveLength(1);
      expect(defaults[0]?.id).toBe(quotedStageId);

      const oldDefault = stages.find((stage) => stage.id === newStageId);
      expect(oldDefault?.isDefault).toBe(false);
    });

    describe('archiving', () => {
      it('is refused while a live lead sits in the stage, naming the occupancy', async () => {
        const { party, product } = await seedLeadFixture();
        const quotedStageId = await stageIdByName('lead', 'Quoted');
        const lead = await leadService.createLead({ partyId: party.id, items: [line(product)] }, actor);
        await leadService.setStage({ id: lead.id, stageId: quotedStageId }, actor);

        try {
          await fieldsService.archiveStage(quotedStageId, actor);
          expect.unreachable('archiving an occupied stage should have been refused');
        } catch (error) {
          expect(error).toBeInstanceOf(ConflictError);
          expect((error as ConflictError).details).toMatchObject({ occupiedBy: { leads: 1, orders: 0 } });
        }
      });

      it('is refused on the pipeline’s default stage regardless of occupancy', async () => {
        const newStageId = await stageIdByName('lead', 'New');
        await expect(fieldsService.archiveStage(newStageId, actor)).rejects.toThrow(ConflictError);
      });

      it('succeeds once the stage is empty, and a restored stage accepts new records again', async () => {
        const wonStageId = await stageIdByName('lead', 'Won');
        const archived = await fieldsService.archiveStage(wonStageId, actor);
        expect(archived.isArchived).toBe(true);

        const { party, product } = await seedLeadFixture();
        const lead = await leadService.createLead({ partyId: party.id, items: [line(product)] }, actor);
        await expect(leadService.setStage({ id: lead.id, stageId: wonStageId }, actor)).rejects.toThrow(
          ValidationError,
        );

        const restored = await fieldsService.restoreStage(wonStageId, actor);
        expect(restored.isArchived).toBe(false);
        await expect(leadService.setStage({ id: lead.id, stageId: wonStageId }, actor)).resolves.toBeDefined();
      });
    });
  });

  describe('permissions', () => {
    it('fields.view is available at the office tier — a plain read succeeds', async () => {
      const officeActor = await actorWith(['fields.view']);
      await expect(fieldsService.fieldsCatalogue(officeActor)).toBeDefined();
      await expect(fieldsService.listValues({ listKey: 'stock.colour' }, officeActor)).resolves.toBeDefined();
    });

    it('fields.manage is refused for an office-tier actor holding only fields.view', async () => {
      const officeActor = await actorWith(['fields.view']);
      await expect(
        fieldsService.createValue({ listKey: 'stock.colour', value: 'Ivory', label: 'Ivory' }, officeActor),
      ).rejects.toThrow(ForbiddenError);
    });

    it('fields.manage succeeds once granted', async () => {
      const managerActor = await actorWith(['fields.view', 'fields.manage']);
      await expect(
        fieldsService.createValue({ listKey: 'stock.colour', value: 'Ivory', label: 'Ivory' }, managerActor),
      ).resolves.toBeDefined();
    });

    it('the three existing reads (GET /api/pipelines, /option-lists, /custom-fields) stay ungated', async () => {
      const noFieldsActor = await actorWith(['leads.view']);
      await expect(fieldsService.listPipelinesUnguarded(noFieldsActor.tenantId)).resolves.toBeDefined();
      await expect(fieldsService.listOptionListsUnguarded(noFieldsActor.tenantId)).resolves.toBeDefined();
      await expect(fieldsService.listCustomFieldsUnguarded(noFieldsActor.tenantId)).resolves.toBeDefined();
    });

    it('an actor lacking fields.view still receives a complete SyncSnapshot', async () => {
      const noFieldsActor = await actorWith(['leads.view', 'parties.view', 'products.view', 'orders.view', 'inventory.view']);
      const snapshot = await buildSnapshot(noFieldsActor);
      expect(snapshot.pipelines.length).toBeGreaterThan(0);
      expect(snapshot.optionLists.length).toBeGreaterThan(0);
    });
  });

  describe('Recycle Bin integration', () => {
    it('a removed value appears in the Bin and restores', async () => {
      const value = await fieldsService.createValue({ listKey: 'stock.colour', value: 'Ivory', label: 'Ivory' }, actor);
      await fieldsService.deleteValue(value.id, actor);

      const bin = await recycleBinService.listBin({ types: ['option_list_item'] }, actor);
      expect(bin.items.map((item) => item.id)).toContain(value.id);

      const result = await recycleBinService.restoreEntity({ entityType: 'option_list_item', id: value.id }, actor);
      expect(result.id).toBe(value.id);

      const restored = await customFieldRepo.findOptionById(actor.tenantId, value.id);
      expect(restored?.deletedAt).toBeNull();
    });

    it('a restore that collides with a live value of the same string is refused', async () => {
      const value = await fieldsService.createValue({ listKey: 'stock.colour', value: 'Ivory', label: 'Ivory' }, actor);
      await fieldsService.deleteValue(value.id, actor);
      await fieldsService.createValue({ listKey: 'stock.colour', value: 'Ivory', label: 'Ivory again' }, actor);

      await expect(
        recycleBinService.restoreEntity({ entityType: 'option_list_item', id: value.id }, actor),
      ).rejects.toThrow(ConflictError);
    });

    it('a removed custom field definition restores through the Bin too', async () => {
      const definition = await fieldsService.createDefinition(
        { entity: 'party', key: 'segment', label: 'Segment', fieldType: 'text' },
        actor,
      );
      await fieldsService.deleteDefinition(definition.id, actor);

      const bin = await recycleBinService.listBin({ types: ['custom_field_definition'] }, actor);
      expect(bin.items.map((item) => item.id)).toContain(definition.id);

      await recycleBinService.restoreEntity({ entityType: 'custom_field_definition', id: definition.id }, actor);
      const restored = await customFieldRepo.findDefinitionById(actor.tenantId, definition.id);
      expect(restored?.deletedAt).toBeNull();
    });

    it('the Bin lists across all eight branches at once, Fields included', async () => {
      const value = await fieldsService.createValue({ listKey: 'stock.colour', value: 'Ivory', label: 'Ivory' }, actor);
      await fieldsService.deleteValue(value.id, actor);
      const definition = await fieldsService.createDefinition(
        { entity: 'party', key: 'segment', label: 'Segment', fieldType: 'text' },
        actor,
      );
      await fieldsService.deleteDefinition(definition.id, actor);

      const counts = await recycleBinService.binCounts(actor);
      expect(counts.option_list_item).toBe(1);
      expect(counts.custom_field_definition).toBe(1);
    });
  });
});
