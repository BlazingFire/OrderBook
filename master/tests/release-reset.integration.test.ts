/**
 * 1.5.9's one-time reset (owner, 2026-11-19; `release-reset.service.ts`): nothing goes until an
 * administrator ticks and gives their password; then a full backup is written first, every
 * order, lead, sub product, product and photo row goes, parties and users stay, numbering
 * carries on, and the snapshot carries the new epoch. Once done it cannot run again.
 */

import fs from 'node:fs';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { RELEASE_RESET_VERSION } from '@orderbook/shared';

import { canRunIntegrationTests } from './helpers/db.js';
import {
  actorWith,
  createServerMasterUser,
  resetData,
  setUpFirstRun,
  setupDatabase,
  teardownDatabase,
  testActor,
} from './helpers/fixtures.js';
import type { ActorContext } from '../src/domain/actor.js';
import { db } from '../src/db/knex.js';
import * as catalogService from '../src/services/catalog.service.js';
import * as leadService from '../src/services/lead.service.js';
import * as orderService from '../src/services/order.service.js';
import * as releaseReset from '../src/services/release-reset.service.js';

let actor: ActorContext;

async function seedBook() {
  const party = await catalogService.createParty({ name: 'Sharma Tiles' }, actor);
  const product = await catalogService.createProduct(
    { name: 'Basin B-1', categoryName: 'Basins', code: 'B-1' },
    actor,
  );
  const line = { productId: product.id, variantId: product.id, quantity: 5, packaging: 'Box' };
  await leadService.createLead({ partyId: party.id, items: [line] }, actor);
  const converted = await leadService.createLead({ partyId: party.id, items: [line] }, actor);
  await orderService.convertLead({ leadId: converted.id }, actor);
  return { party };
}

async function markPending(tenantId: string): Promise<void> {
  await db()('release_resets')
    .insert({ tenant_id: tenantId, release: RELEASE_RESET_VERSION, status: 'pending' })
    .onConflict(['tenant_id', 'release'])
    .merge({ status: 'pending', epoch: null, backup_path: null });
}

const rows = async (table: string) =>
  Number((await db()(table).count<Array<{ count: string }>>('* as count'))[0]?.count);

describe.skipIf(!canRunIntegrationTests)('the 1.5.9 reset (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    actor = await testActor();
  });

  it('deletes nothing without the tick or the right password', async () => {
    const userId = await createServerMasterUser('owner', 'owner-pass-1');
    const admin = await testActor({ userId, actorId: userId });
    await seedBook();
    await markPending(admin.tenantId);

    await expect(
      releaseReset.confirmReleaseReset({ understood: false, confirmPassword: 'owner-pass-1' }, admin),
    ).rejects.toMatchObject({ messageKey: 'validation.releaseReset.notUnderstood' });
    await expect(
      releaseReset.confirmReleaseReset({ understood: true, confirmPassword: 'nope' }, admin),
    ).rejects.toMatchObject({ messageKey: 'validation.dataReset.passwordIncorrect' });

    expect(await rows('products')).toBe(1);
    expect(await rows('orders')).toBe(1);
    expect((await releaseReset.releaseResetStatus(admin)).state).toBe('pending');
  });

  it('backs up, deletes orders and the catalogue, keeps parties and users, and cannot run twice', async () => {
    // The backup names the company, so the Master has to be set up, as a real one is.
    await setUpFirstRun('Reset Ceramics');
    const userId = await createServerMasterUser('owner', 'owner-pass-1');
    const admin = await testActor({ userId, actorId: userId });
    await seedBook();
    await markPending(admin.tenantId);

    const before = await releaseReset.releaseResetStatus(admin);
    expect(before).toMatchObject({
      state: 'pending',
      removes: { newOrders: 2, finalOrders: 1, subProducts: 1, mainProducts: 1 },
      keeps: { parties: 1 },
    });
    expect(await releaseReset.resetEpochFor(admin.tenantId)).toBeNull();

    const result = await releaseReset.confirmReleaseReset({ understood: true, confirmPassword: 'owner-pass-1' }, admin);
    expect(fs.existsSync(result.backupPath)).toBe(true);
    expect(result.removed).toMatchObject({ finalOrders: 1, subProducts: 1, mainProducts: 1 });

    for (const table of ['leads', 'orders', 'line_items', 'products', 'product_categories', 'product_images']) {
      expect(await rows(table), table).toBe(0);
    }
    expect(await rows('parties')).toBe(1);

    const after = await releaseReset.releaseResetStatus(admin);
    expect(after.state).toBe('done');
    expect(after.keeps.users).toBe(before.keeps.users);
    expect(after.backupPath).toBe(result.backupPath);
    expect(await releaseReset.resetEpochFor(admin.tenantId)).toMatch(/^[0-9a-f-]{36}$/);

    await expect(
      releaseReset.confirmReleaseReset({ understood: true, confirmPassword: 'owner-pass-1' }, admin),
    ).rejects.toMatchObject({ messageKey: 'validation.releaseReset.notPending' });

    // The company carries on: a new product and order work as before.
    await seedBook();
    expect(await rows('orders')).toBe(1);
  });

  it('is refused below the admin tier', async () => {
    const office = await actorWith(['settings.manage']);
    await expect(releaseReset.releaseResetStatus(office)).rejects.toMatchObject({ code: 'forbidden' });
  });
});
