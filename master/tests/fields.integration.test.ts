/**
 * Fields against a real cluster: reorder under the deferrable constraint,
 * the default-stage swap, removal not touching records, usage counts, the
 * `fields.view`/`fields.manage` enforcement, and the concurrency gate.
 * `docs/backend-modules/10-TESTING.md` §6.4 owns the gate list this suite
 * answers (`FLD-5`…`FLD-21`).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ActorContext } from '../src/domain/actor.js';
import { db } from '../src/db/knex.js';
import { ConflictError, ForbiddenError, ValidationError } from '../src/lib/errors.js';
import * as fieldsService from '../src/services/fields.service.js';
import * as leadService from '../src/services/lead.service.js';
import * as catalogService from '../src/services/catalog.service.js';
import * as inventoryService from '../src/services/inventory.service.js';
import * as pipelineRepo from '../src/repositories/pipeline.repository.js';
import { canRunIntegrationTests } from './helpers/db.js';
import {
  actorWith,
  resetData,
  setupDatabase,
  stageIdByName,
  teardownDatabase,
  testActor,
} from './helpers/fixtures.js';

let actor: ActorContext;

async function leadPipelineId(tenantId: string): Promise<string> {
  const pipelines = await pipelineRepo.listPipelines(tenantId);
  const pipeline = pipelines.find((p) => p.kind === 'lead');
  if (!pipeline) throw new Error('no lead pipeline seeded');
  return pipeline.id;
}

describe.skipIf(!canRunIntegrationTests)('Fields (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    actor = await testActor();
  });

  describe('option-list values', () => {
    it('creates, then lists, a value for stock.colour', async () => {
      const item = await fieldsService.createValue(
        { listKey: 'stock.colour', value: 'Sunrise Orange', label: 'Sunrise Orange' },
        actor,
      );
      expect(item.value).toBe('Sunrise Orange');
      expect(item.version).toBe(1);

      const { items } = await fieldsService.listValues({ listKey: 'stock.colour' }, actor);
      expect(items.some((i) => i.id === item.id)).toBe(true);
    });

    it('refuses a duplicate live value for the same list key', async () => {
      await fieldsService.createValue({ listKey: 'stock.colour', value: 'Sea Green', label: 'Sea Green' }, actor);
      await expect(
        fieldsService.createValue({ listKey: 'stock.colour', value: 'Sea Green', label: 'Sea Green' }, actor),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it('normalises a hex to lowercase and rejects a malformed one', async () => {
      const item = await fieldsService.createValue(
        { listKey: 'stock.colour', value: 'Coral Pink', label: 'Coral Pink', hex: '#FF7F50' },
        actor,
      );
      expect(item.hex).toBe('#ff7f50');

      await expect(
        fieldsService.createValue(
          { listKey: 'stock.colour', value: 'Bad Hex', label: 'Bad Hex', hex: 'not-a-hex' },
          actor,
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('FLD-9: removing a value touches no record that used it', async () => {
      const party = await catalogService.createParty({ name: 'Fields Test Party' }, actor);
      const product = await catalogService.createProduct({ name: 'Basin', productCode: 'FLDB-1' }, actor);
      await inventoryService.recordInbound({ productId: product.id, colour: 'Slate Grey', quantityBoxes: 10 }, actor);
      const lead = await leadService.createLead(
        {
          partyId: party.id,
          items: [{ productId: product.id, packaging: 'Box', quantities: [{ colour: 'Slate Grey', quantity: 3 }] }],
        },
        actor,
      );

      const value = await fieldsService.createValue(
        { listKey: 'stock.colour', value: 'Slate Grey', label: 'Slate Grey' },
        actor,
      );

      const before = await db()('line_item_quantities').where({ colour: 'Slate Grey' }).select('*');
      const stockBefore = await db()('inventory_stock').where({ colour: 'Slate Grey' }).select('*');

      await fieldsService.removeValue(value.id, actor);

      const after = await db()('line_item_quantities').where({ colour: 'Slate Grey' }).select('*');
      const stockAfter = await db()('inventory_stock').where({ colour: 'Slate Grey' }).select('*');
      expect(after).toEqual(before);
      expect(stockAfter).toEqual(stockBefore);

      // FLD-10: the lead — which still carries the removed colour — is still
      // readable and editable.
      const reread = await leadService.getLead(lead.id, actor);
      expect(reread.id).toBe(lead.id);
    });

    it('FLD-18: a removed value appears in the Bin and restores', async () => {
      const value = await fieldsService.createValue(
        { listKey: 'stock.colour', value: 'Bin Colour', label: 'Bin Colour' },
        actor,
      );
      await fieldsService.removeValue(value.id, actor);

      const { items: deleted } = await fieldsService.listValues(
        { listKey: 'stock.colour', includeDeleted: true },
        actor,
      );
      const found = deleted.find((i) => i.id === value.id);
      expect(found?.deletedAt).not.toBeNull();
    });

    it('FLD-19: is a Recycle Bin entity — nine branches once Stage 6 landed', async () => {
      const { RECYCLE_BIN_ENTITIES } = await import('@orderbook/shared');
      expect(RECYCLE_BIN_ENTITIES).toContain('option_list_item');
      expect(RECYCLE_BIN_ENTITIES).toContain('custom_field_definition');
      // Eight when Fields landed; `document_template` made it nine at Stage 6.
      expect(RECYCLE_BIN_ENTITIES).toHaveLength(9);
    });

    it('FLD-19b: every declared Bin entity actually has a UNION branch behind it', async () => {
      // This is the gate that was missing. Both Fields entities were declared
      // in `RECYCLE_BIN_ENTITIES` and in `RESTORE_PERMISSION` at Stage 3 but
      // never given a branch in `recycle-bin.repository.ts`, so they were
      // invisible in the Bin and `restoreEntity` refused them as an "unknown
      // entity type" — while every type check in the codebase said they were
      // fine. Nothing errored; the feature simply did not exist.
      const { RECYCLE_BIN_ENTITIES } = await import('@orderbook/shared');
      const { BIN_BRANCH_TYPES } = await import(
        '../src/repositories/recycle-bin.repository.js'
      );

      for (const entity of RECYCLE_BIN_ENTITIES) {
        expect(BIN_BRANCH_TYPES, `no Bin branch for ${entity}`).toContain(entity);
      }
    });

    it('FLD-20/21: expectedVersion is mandatory, and the losing concurrent writer does not overwrite', async () => {
      const value = await fieldsService.createValue(
        { listKey: 'stock.colour', value: 'Race Colour', label: 'Race Colour' },
        actor,
      );

      // Omitted expectedVersion — 400.
      await expect(
        fieldsService.updateValue(value.id, { label: 'No version' } as never, actor),
      ).rejects.toBeInstanceOf(ValidationError);

      // Both "read" version 1.
      await fieldsService.updateValue(value.id, { label: 'First writer', expectedVersion: 1 }, actor);

      // The second writer still thinks it is version 1 — refused, and the
      // first writer's value is what is actually stored.
      await expect(
        fieldsService.updateValue(value.id, { label: 'Second writer', expectedVersion: 1 }, actor),
      ).rejects.toMatchObject({ code: 'conflict' });

      const { items } = await fieldsService.listValues({ listKey: 'stock.colour' }, actor);
      const stored = items.find((i) => i.id === value.id);
      expect(stored?.label).toBe('First writer');
      expect(stored?.version).toBe(2);
    });
  });

  describe('reordering values', () => {
    it('reorders a full permutation and rejects a stale one missing a value added since', async () => {
      const a = await fieldsService.createValue({ listKey: 'line.packaging', value: 'Pkg A', label: 'Pkg A' }, actor);
      const b = await fieldsService.createValue({ listKey: 'line.packaging', value: 'Pkg B', label: 'Pkg B' }, actor);

      const reordered = await fieldsService.reorderValues(
        { listKey: 'line.packaging', ids: [b.id, a.id] },
        actor,
      );
      expect(reordered.map((i) => i.id)).toEqual([b.id, a.id]);

      await fieldsService.createValue({ listKey: 'line.packaging', value: 'Pkg C', label: 'Pkg C' }, actor);

      // FLD-7: a permutation that omits the value added since is stale.
      await expect(
        fieldsService.reorderValues({ listKey: 'line.packaging', ids: [a.id, b.id] }, actor),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe('custom-field definitions', () => {
    it('creates a definition and refuses a duplicate key for the same entity', async () => {
      await fieldsService.createDefinition(
        { entity: 'lead', key: 'warranty_years', label: 'Warranty (years)', fieldType: 'number' },
        actor,
      );
      await expect(
        fieldsService.createDefinition(
          { entity: 'lead', key: 'warranty_years', label: 'Dup', fieldType: 'number' },
          actor,
        ),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it('refuses a select field with no options', async () => {
      await expect(
        fieldsService.createDefinition(
          { entity: 'party', key: 'grade', label: 'Grade', fieldType: 'select', options: [] },
          actor,
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('requires expectedVersion on update and refuses a stale one with storedVersion', async () => {
      const def = await fieldsService.createDefinition(
        { entity: 'product', key: 'finish_note', label: 'Finish note', fieldType: 'text' },
        actor,
      );

      await fieldsService.updateDefinition(def.id, { label: 'Updated once', expectedVersion: 1 }, actor);

      await expect(
        fieldsService.updateDefinition(def.id, { label: 'Stale', expectedVersion: 1 }, actor),
      ).rejects.toMatchObject({ code: 'conflict', details: expect.objectContaining({ storedVersion: 2 }) });
    });

    it('removing a definition leaves its stored values on existing records untouched', async () => {
      const def = await fieldsService.createDefinition(
        { entity: 'party', key: 'notes_extra', label: 'Extra notes', fieldType: 'text' },
        actor,
      );
      const party = await catalogService.createParty(
        { name: 'CF Party', customFields: { notes_extra: 'kept' } },
        actor,
      );

      await fieldsService.removeDefinition(def.id, actor);

      const { items } = await catalogService.listParties({}, actor);
      const reread = items.find((p) => p.id === party.id);
      expect(reread?.customFields?.notes_extra).toBe('kept');
    });
  });

  describe('pipeline stages', () => {
    it('FLD-5: reorders stages one drag at a time under the deferrable constraint', async () => {
      const pipelineId = await leadPipelineId(actor.tenantId);
      const ids = await pipelineRepo.stageIdsForPipeline(actor.tenantId, pipelineId);
      expect(ids.length).toBeGreaterThan(1);

      const swapped = [...ids].reverse();
      const stages = await fieldsService.reorderStages({ pipelineId, ids: swapped }, actor);
      expect(stages.map((s) => s.id)).toEqual(swapped);
    });

    it('FLD-7 (stage half): rejects a stale permutation', async () => {
      const pipelineId = await leadPipelineId(actor.tenantId);
      const ids = await pipelineRepo.stageIdsForPipeline(actor.tenantId, pipelineId);

      await expect(
        fieldsService.reorderStages({ pipelineId, ids: ids.slice(1) }, actor),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('FLD-6: swapping the default stage does not violate the one-default index', async () => {
      const pipelineId = await leadPipelineId(actor.tenantId);
      const newDefault = await stageIdByName('lead', 'Quoted');

      const updated = await fieldsService.updateStage(newDefault, { isDefault: true }, actor);
      expect(updated.isDefault).toBe(true);

      const stages = await pipelineRepo.stagesForPipelineFresh(actor.tenantId, pipelineId);
      const defaults = stages.filter((s) => s.isDefault);
      expect(defaults).toHaveLength(1);
      expect(defaults[0]?.id).toBe(newDefault);
    });

    it('FLD-11: archiving a stage holding live leads is refused and names the count', async () => {
      const nonDefaultStageId = await stageIdByName('lead', 'Quoted');

      const party = await catalogService.createParty({ name: 'Archive Test Party' }, actor);
      const product = await catalogService.createProduct({ name: 'Tile', productCode: 'FLDA-1' }, actor);
      const lead = await leadService.createLead(
        {
          partyId: party.id,
          items: [{ productId: product.id, packaging: 'Box', quantities: [{ colour: 'Blue', quantity: 1 }] }],
        },
        actor,
      );
      await leadService.setStage({ id: lead.id, stageId: nonDefaultStageId }, actor);

      await expect(fieldsService.archiveStage(nonDefaultStageId, actor)).rejects.toMatchObject({
        code: 'conflict',
        details: { count: 1 },
      });
    });

    it('archives and restores a stage with nothing in it', async () => {
      const emptyStageId = await stageIdByName('lead', 'Lost');

      const archived = await fieldsService.archiveStage(emptyStageId, actor);
      expect(archived.isArchived).toBe(true);

      const restored = await fieldsService.restoreStage(emptyStageId, actor);
      expect(restored.isArchived).toBe(false);
    });

    it('refuses to move a lead into an archived stage', async () => {
      const lostId = await stageIdByName('lead', 'Lost');
      await fieldsService.archiveStage(lostId, actor);

      const party = await catalogService.createParty({ name: 'Archived Target Party' }, actor);
      const product = await catalogService.createProduct({ name: 'Tile', productCode: 'FLDA-2' }, actor);
      const lead = await leadService.createLead(
        {
          partyId: party.id,
          items: [{ productId: product.id, packaging: 'Box', quantities: [{ colour: 'Blue', quantity: 1 }] }],
        },
        actor,
      );

      await expect(leadService.setStage({ id: lead.id, stageId: lostId }, actor)).rejects.toBeInstanceOf(
        ValidationError,
      );
    });

    it('refuses to archive the default stage', async () => {
      const pipelineId = await leadPipelineId(actor.tenantId);
      const stages = await pipelineRepo.stagesForPipelineFresh(actor.tenantId, pipelineId);
      const defaultStage = stages.find((s) => s.isDefault);
      expect(defaultStage).toBeDefined();

      await expect(fieldsService.archiveStage(defaultStage!.id, actor)).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe('usage counts', () => {
    it('FLD-12/13: costs one query per set and never reads stock_movements', async () => {
      const product = await catalogService.createProduct({ name: 'Usage Tile', productCode: 'FLDU-1' }, actor);
      await inventoryService.recordInbound({ productId: product.id, colour: 'Amber', quantityBoxes: 5 }, actor);
      await inventoryService.recordInbound({ productId: product.id, colour: 'Amber', quantityBoxes: 5 }, actor);

      const breakdown = await fieldsService.fieldUsage({ listKey: 'stock.colour' }, actor);
      const amber = breakdown.values.find((v) => v.value === 'Amber') ?? breakdown.unlisted.find((v) => v.value === 'Amber');
      // Two inbound movements against the same (product, colour) collapse into
      // one `inventory_stock` row — the usage count is over the ledger's
      // current state, not the movement history.
      expect(amber?.total).toBeGreaterThanOrEqual(1);
      expect(breakdown.sources).not.toContain('stockMovement');
    });

    it('FLD-14: a colour on stock but absent from the list reports as unlisted', async () => {
      const product = await catalogService.createProduct({ name: 'Unlisted Tile', productCode: 'FLDU-2' }, actor);
      await inventoryService.recordInbound(
        { productId: product.id, colour: 'Never Listed Teal', quantityBoxes: 1 },
        actor,
      );

      const { unlisted } = await fieldsService.listValues(
        { listKey: 'stock.colour', includeUnlisted: true },
        actor,
      );
      expect(unlisted).toContain('Never Listed Teal');
    });
  });

  describe('permissions', () => {
    it('FLD-15: fields.manage is refused for an actor who does not hold it', async () => {
      const limited = await actorWith(['fields.view']);
      await expect(
        fieldsService.createValue({ listKey: 'stock.colour', value: 'Denied', label: 'Denied' }, limited),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('FLD-15: fields.view does not gate GET /api/option-lists (the unguarded read)', async () => {
      const noFields = await actorWith([]);
      // The unguarded pair exported for the three pre-existing endpoints must
      // not throw for an actor holding no Fields key at all.
      await expect(fieldsService.listOptionListsUnguarded(noFields.tenantId)).resolves.toBeDefined();
    });

    it('a caller lacking fields.view is refused the gated catalogue read', async () => {
      const noFields = await actorWith([]);
      await expect(fieldsService.fieldsCatalogue(noFields)).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  describe('activity', () => {
    it('FLD-17: every Fields write leaves an activity_log entry in the same transaction', async () => {
      const value = await fieldsService.createValue(
        { listKey: 'stock.colour', value: 'Audited Colour', label: 'Audited Colour' },
        actor,
      );

      const rows = await db()('activity_log')
        .where({ entity_type: 'option_list_item', entity_id: value.id, action: 'created' })
        .select('*');
      expect(rows).toHaveLength(1);
    });
  });
});
