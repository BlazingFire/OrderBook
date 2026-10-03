/**
 * 1.4 D3 (R3–R5): brands, packaging and grades are written under
 * `catalog.lists.manage`; every other list stays behind `fields.manage`; the
 * grant migration reaches the admin tiers and any role that held `fields.manage`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { db } from '../src/db/knex.js';
import { up as grantCatalogLists } from '../src/db/migrations/20261012000000_catalog_lists_grant.js';
import { ForbiddenError } from '../src/lib/errors.js';
import * as fieldsService from '../src/services/fields.service.js';
import * as recycleBinService from '../src/services/recycle-bin.service.js';
import { canRunIntegrationTests } from './helpers/db.js';
import { actorWith, resetData, setupDatabase, teardownDatabase, testTenantId } from './helpers/fixtures.js';

const LISTS = ['line.grade', 'line.packaging', 'product.brand'] as const;

async function insertRole(tier: string, permissions: string[]): Promise<string> {
  const id = `RL${Math.random().toString(36).slice(2, 12).toUpperCase()}`;
  await db()('roles').insert({
    id,
    tenant_id: await testTenantId(),
    name: `Test ${id}`,
    tier,
    permissions: JSON.stringify(permissions),
    is_system: false,
  });
  return id;
}

async function permissionsOf(id: string): Promise<string[]> {
  const row = await db()('roles').where({ id }).first<{ permissions: unknown }>('permissions');
  return Array.isArray(row?.permissions) ? (row.permissions as string[]) : [];
}

describe.skipIf(!canRunIntegrationTests)('catalog lists (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(resetData);

  it.each(LISTS)('%s: the catalog key adds, renames, reorders, retires and restores a value', async (listKey) => {
    const actor = await actorWith(['catalog.lists.manage']);

    const created = await fieldsService.createValue({ listKey, value: 'Zeta One', label: 'Zeta One' }, actor);
    const renamed = await fieldsService.updateValue(
      created.id,
      { label: 'Zeta Uno', expectedVersion: created.version },
      actor,
    );
    expect(renamed.label).toBe('Zeta Uno');

    const { items } = await fieldsService.listValues({ listKey }, await actorWith(['fields.view']));
    await fieldsService.reorderValues({ listKey, ids: items.map((item) => item.id).reverse() }, actor);

    await fieldsService.deleteValue(created.id, actor);
    const restored = await fieldsService.restoreValue(created.id, actor);
    expect(restored.deletedAt).toBeNull();
  });

  it.each(LISTS)('%s: fields.manage alone is refused, naming catalog.lists.manage', async (listKey) => {
    const manager = await actorWith(['catalog.lists.manage']);
    const created = await fieldsService.createValue({ listKey, value: 'Held', label: 'Held' }, manager);
    const fieldsOnly = await actorWith(['fields.manage', 'fields.view']);

    const attempts: Array<() => Promise<unknown>> = [
      () => fieldsService.createValue({ listKey, value: 'Nope', label: 'Nope' }, fieldsOnly),
      () => fieldsService.updateValue(created.id, { label: 'X', expectedVersion: created.version }, fieldsOnly),
      () => fieldsService.deleteValue(created.id, fieldsOnly),
      () => fieldsService.restoreValue(created.id, fieldsOnly),
      () => fieldsService.reorderValues({ listKey, ids: [created.id] }, fieldsOnly),
    ];
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toThrow(ForbiddenError);
      await expect(attempt()).rejects.toMatchObject({ message: expect.stringContaining('catalog.lists.manage') });
    }
  });

  it('the catalog key does not open the other lists', async () => {
    const actor = await actorWith(['catalog.lists.manage']);
    await expect(
      fieldsService.createValue({ listKey: 'lead.sourcePlatform', value: 'Radio', label: 'Radio' }, actor),
    ).rejects.toThrow(ForbiddenError);
  });

  it('fields.manage still writes the other lists', async () => {
    const actor = await actorWith(['fields.manage']);
    const created = await fieldsService.createValue({ listKey: 'lead.sourcePlatform', value: 'Radio', label: 'Radio' }, actor);
    expect(created.value).toBe('Radio');
  });

  it('anyone signed in reads the three lists; every other list still needs fields.view', async () => {
    const nobody = await actorWith([]);
    for (const listKey of LISTS) {
      await expect(fieldsService.listValues({ listKey }, nobody)).resolves.toBeTruthy();
      await expect(fieldsService.fieldUsage({ listKey }, nobody)).resolves.toBeTruthy();
    }
    await expect(fieldsService.listValues({ listKey: 'lead.sourcePlatform' }, nobody)).rejects.toThrow(
      ForbiddenError,
    );
    await expect(fieldsService.fieldUsage({ listKey: 'lead.sourcePlatform' }, nobody)).rejects.toThrow(
      ForbiddenError,
    );
  });

  it('a caller with neither key learns nothing about an id', async () => {
    const nobody = await actorWith(['fields.view']);
    await expect(fieldsService.deleteValue('00000000-0000-0000-0000-000000000000', nobody)).rejects.toThrow(
      ForbiddenError,
    );
  });

  describe('Recycle Bin (1.4 rework)', () => {
    const bin = ['recycleBin.view', 'recycleBin.viewAll'];

    async function deleteOne(listKey: 'line.grade' | 'lead.sourcePlatform', value: string): Promise<string> {
      const full = await actorWith(['catalog.lists.manage', 'fields.manage']);
      const created = await fieldsService.createValue({ listKey, value, label: value }, full);
      await fieldsService.deleteValue(created.id, full);
      return created.id;
    }

    it('shows a lists-key holder only the deleted values of the three lists, and restores them', async () => {
      const gradeId = await deleteOne('line.grade', 'Old grade');
      const sourceId = await deleteOne('lead.sourcePlatform', 'Old source');
      const clerk = await actorWith(['catalog.lists.manage', ...bin]);

      const page = await recycleBinService.listBin({}, clerk);
      expect(page.items.map((entry) => entry.id)).toEqual([gradeId]);
      expect(await recycleBinService.binCounts(clerk)).toEqual({ option_list_item: 1 });

      await expect(
        recycleBinService.restoreEntity({ entityType: 'option_list_item', id: sourceId }, clerk),
      ).rejects.toThrow(ForbiddenError);
      const restored = await recycleBinService.restoreEntity({ entityType: 'option_list_item', id: gradeId }, clerk);
      expect(restored.id).toBe(gradeId);
      expect((await recycleBinService.listBin({}, clerk)).items).toEqual([]);
    });

    it('shows a fields.manage holder the deleted values of every list, as before', async () => {
      const gradeId = await deleteOne('line.grade', 'Old grade');
      const sourceId = await deleteOne('lead.sourcePlatform', 'Old source');
      const fieldsOnly = await actorWith(['fields.manage', ...bin]);

      const ids = (await recycleBinService.listBin({}, fieldsOnly)).items.map((entry) => entry.id).sort();
      expect(ids).toEqual([gradeId, sourceId].sort());
    });

    it('shows nothing to a holder of neither key', async () => {
      await deleteOne('line.grade', 'Old grade');
      const nobody = await actorWith(bin);
      expect((await recycleBinService.listBin({}, nobody)).items).toEqual([]);
    });
  });

  describe('grant migration', () => {
    const KEY = 'catalog.lists.manage';

    it('grants the admin tiers and any role that held fields.manage, as a sorted union, idempotently', async () => {
      const admin = await insertRole('admin', ['users.manage']);
      const serverMaster = await insertRole('server_master', ['leads.view']);
      const manager = await insertRole('management', ['leads.view', 'fields.manage']);
      const plain = await insertRole('management', ['leads.view']);

      await grantCatalogLists(db());
      await grantCatalogLists(db());

      expect(await permissionsOf(admin)).toEqual([KEY, 'users.manage'].sort());
      expect(await permissionsOf(serverMaster)).toEqual(['leads.view', KEY].sort());
      expect(await permissionsOf(manager)).toEqual(['fields.manage', 'leads.view', KEY].sort());
      expect(await permissionsOf(plain)).toEqual(['leads.view']);
    });
  });
});
