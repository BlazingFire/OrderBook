/**
 * Probe, lens A (verifier): field-fidelity defects the first audit pass did not
 * list. Same harness as A-field-fidelity: build through the services, export
 * the product zip, restore into an emptied catalogue or over the same one, and
 * compare the tables a person can set.
 */

import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ActorContext } from '../../src/domain/actor.js';
import { db } from '../../src/db/knex.js';
import * as customFieldRepo from '../../src/repositories/custom-field.repository.js';
import * as catalog from '../../src/services/catalog.service.js';
import * as fields from '../../src/services/fields.service.js';
import {
  exportProductZip,
  previewProductZip,
  restoreProductZip,
} from '../../src/services/product-zip.service.js';
import { canRunIntegrationTests } from '../helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor } from '../helpers/fixtures.js';

let admin: ActorContext;
let dir: string;

async function exported(): Promise<string> {
  const { filePath } = await exportProductZip(admin);
  const file = path.join(dir, `${randomUUID()}.zip`);
  await copyFile(filePath, file);
  await rm(filePath, { force: true });
  return file;
}

async function emptyAll(): Promise<void> {
  await resetData();
  customFieldRepo.invalidateFieldCache();
}

const brands = async () =>
  (
    await db()('option_lists')
      .where({ tenant_id: admin.tenantId, list_key: 'product.brand' })
      .whereNull('deleted_at')
      .orderBy('sequence')
      .select('value')
  ).map((row: { value: string }) => row.value);

const subs = async () =>
  db()('products as p')
    .join('product_variants as v', 'v.product_id', 'p.id')
    .where('p.tenant_id', admin.tenantId)
    .whereNull('p.deleted_at')
    .whereNull('v.deleted_at')
    .orderBy('v.code')
    .select('p.name', 'v.code');

const value = (listKey: 'stock.colour' | 'product.brand', v: string) =>
  fields.createValue({ listKey, value: v, label: v, hex: null }, admin);

describe.skipIf(!canRunIntegrationTests)('probe Av: field fidelity, missed by the first pass', () => {
  beforeAll(async () => {
    await setupDatabase();
  }, 120_000);
  afterAll(async () => {
    await teardownDatabase();
  });
  beforeEach(async () => {
    await emptyAll();
    admin = await testActor();
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = await mkdtemp(path.join(os.tmpdir(), 'probe-av-'));
  });

  it('Av-1 a brand with a double space comes back once (no second, collapsed brand in the Brands list)', async () => {
    await value('product.brand', 'Swis  ware');
    const main = await catalog.createCategory({ name: 'M', code: 'M', brand: 'Swis  ware', sortOrder: 1 }, admin);
    await catalog.createProduct(
      { categoryId: main.id, name: 'S', hasVariants: false, variants: [{ code: 'M-1', label: null }] },
      admin,
    );
    const before = await brands();
    const file = await exported();
    await emptyAll();
    await restoreProductZip(file, 'p.zip', {}, admin);
    expect(await brands()).toEqual(before);
  });

  it('Av-2 two sub products the form allows side by side ("TWO SPACES" and "TWO  SPACES") both come back', async () => {
    await value('product.brand', 'B');
    const main = await catalog.createCategory({ name: 'M', code: 'M', brand: 'B', sortOrder: 1 }, admin);
    await catalog.createProduct(
      { categoryId: main.id, name: 'TWO SPACES', hasVariants: false, variants: [{ code: 'T-1', label: null }] },
      admin,
    );
    await catalog.createProduct(
      { categoryId: main.id, name: 'TWO  SPACES', hasVariants: false, variants: [{ code: 'T-2', label: null }] },
      admin,
    );
    const before = await subs();
    expect(before).toHaveLength(2);
    const file = await exported();
    await emptyAll();
    const report = await restoreProductZip(file, 'p.zip', {}, admin);
    expect({ failed: report.products.failed, subs: await subs() }).toEqual({ failed: 0, subs: before });
  });

  it('Av-3 a single non-breaking space in a name reads as unchanged over the same catalogue', async () => {
    await value('product.brand', 'B');
    const main = await catalog.createCategory({ name: 'M', code: 'M', brand: 'B', sortOrder: 1 }, admin);
    await catalog.createProduct(
      { categoryId: main.id, name: 'ROYAL SET', hasVariants: false, variants: [{ code: 'R-1', label: null }] },
      admin,
    );
    const before = await subs();
    const file = await exported();
    const preview = await previewProductZip(file, 'p.zip', admin);
    await restoreProductZip(file, 'p.zip', {}, admin);
    expect({ changed: preview.rows.changed, subs: await subs() }).toEqual({ changed: [], subs: before });
  });
});
