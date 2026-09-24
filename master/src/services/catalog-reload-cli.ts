/**
 * One-shot operator tool: empty the business data, then optionally load the
 * Swisware catalogue or a few sample parties. Three scripts in
 * `master/package.json` run it (`npm run <script> --workspace @orderbook/master`):
 *
 *   wipe:business   (no flag)         wipe only.
 *   reload:catalog  --with-catalog    wipe, then load the Swisware catalogue —
 *                                     the same `seedCatalogue` the Developer
 *                                     tool and `seed:catalogue` run (pure data
 *                                     in `domain/swisware-catalogue.ts`; no
 *                                     CSV, no file).
 *   seed:parties    --with-parties    wipe, then create three sample parties
 *                                     through `createParty`.
 *
 * The wipe takes products, variants, categories, image rows, leads, orders,
 * line items, stock, reservations, movements, timelines, party-wise records,
 * parties, party access, the sync/conflict bookkeeping and **the whole
 * activity log** to zero and restarts their id counters, while keeping the
 * configuration (tenants, users, roles, permissions, pipelines, option lists,
 * settings, panels, connectors, keys, secrets). No configuration table has a
 * foreign key into the wiped ones, so `TRUNCATE … CASCADE` reaches nothing
 * else — `operator-cli.integration.test.ts` fails the day one does.
 *
 * The activity log goes on purpose: every entry in it describes a record the
 * wipe removes. No ordinary write can remove an entry — its row triggers
 * refuse every UPDATE and DELETE — but a TRUNCATE fires no row trigger (a
 * backup restore relies on the same), so this tool empties it, and the hash
 * chain starts again from genesis with the next write. On a live database that
 * is the audit trail disappearing, so the console says so, with the count,
 * before it happens.
 *
 * Image files on disk are left alone: with their rows gone, the Master's
 * startup sweep (`sweepOrphanImageVariants`) removes them on its next boot.
 *
 * Run it with the Master stopped. It starts the database the way the Master
 * does and stops it again when done, which would pull the database out from
 * under a running Master, and nothing here reaches that Master's in-memory
 * caches. With `DATABASE_URL` set it uses that server instead and stops
 * nothing — which is how the integration test runs it.
 *
 * Never imported by app code or tests; the test runs it as a process.
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

    const products = await db()('products').whereNull('deleted_at').count('id as count');
    const activity = await db()('activity_log').count('id as count');
    log.warn(
      `Erasing all business data (${String((products[0] as { count: string }).count)} live products) ` +
        `and the whole activity log (${String((activity[0] as { count: string }).count)} activity entries, ` +
        'the audit trail). There is no undo short of a backup.',
    );

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
    log.info('Business data and the activity log erased; users, roles, settings and panels kept.');

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
