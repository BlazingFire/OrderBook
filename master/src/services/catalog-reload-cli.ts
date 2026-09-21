/**
 * One-shot operator script: empty business data, optionally reloading the
 * catalogue and sample parties.
 *
 * Default (no flags): wipes business data (products, variants, categories,
 * images, leads, orders, line items, inventory, reservations, movements,
 * timeline, party-wise rates, parties, access, sync/conflict bookkeeping,
 * activity) to zero while keeping configuration (tenants, users, roles,
 * permissions, pipelines, option lists, settings, panels, connectors, keys,
 * secrets).
 *
 * Flags:
 *   --with-catalog  also load the Swisware catalogue afterwards — the same
 *                   `seedCatalogue` the Developer tool runs (pure data in
 *                   `domain/swisware-catalogue.ts`; no CSV, no file).
 *   --with-parties  also create a few sample parties through createParty.
 *
 * Run: npm run ... --workspace @orderbook/master (see package.json script)
 * Never imported by app code or tests.
 */
import { PERMISSIONS, type PartyInput, type PermissionSet } from '@orderbook/shared';

import { closeDatabase, db, initDatabase, runMigrations } from '../db/knex.js';
import { startPostgres } from '../db/postgres-server.js';
import { createLogger } from '../lib/logger.js';
import type { ActorContext } from '../domain/actor.js';
import { createParty } from './catalog.service.js';
import { seedCatalogue } from './catalogue-seed.service.js';

const log = createLogger('catalog-reload');

const BUSINESS_TABLES = [
  'stock_reservations',
  'stock_movements',
  'inventory_stock',
  'line_items',
  'timeline_entries',
  'orders',
  'leads',
  'party_product_variants',
  'party_access',
  'product_images',
  'product_variants',
  'products',
  'product_categories',
  'parties',
  'sync_conflicts',
  'applied_mutations',
  'id_map',
  'activity_log',
];

const SAMPLE_PARTIES: PartyInput[] = [
  { name: 'Patel Tiles & Sanitary', phone: '9876543210', city: 'Morbi', state: 'Gujarat', notes: 'Sample dealer' },
  { name: 'Shree Balaji Traders', phone: '9123456780', city: 'Rajkot', state: 'Gujarat' },
  { name: 'New Home Ceramics', city: 'Ahmedabad', state: 'Gujarat' },
];

async function main(): Promise<void> {
  const withCatalog = process.argv.includes('--with-catalog');
  const withParties = process.argv.includes('--with-parties');
  const handle = await startPostgres();
  initDatabase(handle.connectionUrl);

  try {
    await runMigrations();
    const tenantRow = await db()('tenants').orderBy('created_at').first<{ id: string }>('id');
    if (!tenantRow) throw new Error('No tenant — run first-time setup before reloading the catalogue');
    const tenantId = tenantRow.id;

    const before = await db()('products').whereNull('deleted_at').count('id as count');
    log.info(`Live products before wipe: ${String((before[0] as { count: string }).count)}`);

    await db().transaction(async (trx) => {
      await trx.raw(`TRUNCATE TABLE ${BUSINESS_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
      await trx.raw('ALTER SEQUENCE party_code_seq RESTART WITH 1');
      for (const entity of [
        'lead',
        'line_item',
        'order',
        'party',
        'party_variant',
        'product',
        'product_category',
        'product_variant',
        'reservation',
        'timeline_entry',
      ]) {
        await trx('id_sequences').where({ tenant_id: tenantId, entity }).update({ next_value: 1 });
      }
      await trx('master_clock').where({ id: 1 }).update({ physical: 0, counter: 0 });
    });
    log.info('Business data wiped; users, roles, settings and panels kept.');

    const permissions: PermissionSet = {
      roleId: null,
      roleName: 'Reload',
      tier: 'admin',
      permissions: PERMISSIONS,
    };
    const actor: ActorContext = {
      tenantId,
      actorType: 'user' as const,
      actorId: null,
      userId: null,
      permissions,
      deviceCode: null,
      actorName: 'Catalog reload',
    };

    if (withCatalog) {
      const result = await seedCatalogue({ actor });
      log.info(
        `Catalogue loaded: categories=${result.categories} models=${result.products} variants=${result.variants} skipped=${result.skipped}`,
      );
    }

    if (withParties) {
      for (const input of SAMPLE_PARTIES) {
        const party = await createParty(input, actor);
        log.info(`Party created: ${party.partyCode} ${party.name}`);
      }
    }
  } finally {
    await closeDatabase();
    await handle.stop();
  }
}

main().catch((error) => {
  log.error('Catalog reload failed', error);
  process.exitCode = 1;
});
