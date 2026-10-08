/**
 * `20261016000000_product_image_source_checksum`: a nullable text column, the
 * rows already there kept as they were with null in it, and a second run a
 * no-op. What fills it, and what reads it, is `product-zip.integration.test.ts`.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db } from '../src/db/knex.js';
import { down, up } from '../src/db/migrations/20261016000000_product_image_source_checksum.js';
import { canRunIntegrationTests } from './helpers/db.js';
import {
  createTestProduct,
  resetData,
  setupDatabase,
  teardownDatabase,
  testActor,
  testTenantId,
} from './helpers/fixtures.js';

describe.skipIf(!canRunIntegrationTests)('product image source checksum migration (integration)', () => {
  beforeAll(setupDatabase, 120_000);
  afterAll(teardownDatabase);

  it('adds a nullable column, keeps the rows it finds with null in it, and runs twice', async () => {
    await resetData();
    const { product } = await createTestProduct(await testActor(), { name: 'Checksum Tile' });
    const id = randomUUID();
    try {
      // A database from before it: the column gone, a photo already there.
      await down(db());
      await db()('product_images').insert({
        id,
        tenant_id: await testTenantId(),
        product_id: product.id,
        width: 1,
        height: 1,
        checksum: 'master-hash',
        blurhash: 'x',
        byte_size: 1,
      });
      await up(db());
      await up(db());
    } finally {
      await up(db());
    }

    const columns = await db().raw(
      `SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'product_images' AND column_name = 'source_checksum'`,
    );
    expect(columns.rows).toEqual([{ data_type: 'text', is_nullable: 'YES' }]);
    expect(await db()('product_images').where({ id }).first('checksum', 'source_checksum')).toEqual({
      checksum: 'master-hash',
      source_checksum: null,
    });
  });
});
