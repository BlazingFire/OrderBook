/**
 * One-shot operator tool over the live database. Four scripts in
 * `master/package.json` run it (`npm run <script> --workspace @orderbook/master`):
 *
 *   reload:catalog    --catalogue      replace the catalogue with the shipped
 *                                      `master/assets/catalogue/swisware-plus-2026.md`
 *                                      (`docs/catalogue/CATALOGUE_MODEL.md` §4) —
 *                                      `loadCatalogue({ replace: true })`, one
 *                                      transaction. Clears the catalogue and
 *                                      what quotes it (leads, orders, their
 *                                      lines, stock, movements, reservations,
 *                                      party-wise records, photo rows) and
 *                                      **keeps parties, people, roles, settings,
 *                                      option lists and the activity log**,
 *                                      adding one `catalog.reloaded` row.
 *   seed:demo-parties --demo-parties   add the 13 demo dealers below; wipes
 *                                      nothing, and a name already on the books
 *                                      is skipped.
 *   wipe:business     (no flag)        wipe only.
 *   seed:parties      --with-parties   wipe, then three sample parties through
 *                                      `createParty`.
 *
 * `--with-catalog` (no script of its own) wipes and then loads the catalogue
 * into the emptied master — what `reload:catalog` did before catalogue v2,
 * kept for `npm run wipe:business -- --with-catalog`.
 *
 * The wipe takes products, variants, categories, image rows, leads, orders,
 * line items, stock, reservations, movements, timelines, party-wise records,
 * parties, party access, the sync/conflict bookkeeping, the connectors' links
 * and **the whole activity log** to zero and restarts their id counters, while
 * keeping the configuration (tenants, users, roles, permissions, pipelines,
 * option lists, settings, panels, connectors and their mappings and run
 * history, keys, secrets). No configuration table has a foreign key into the
 * wiped ones, so `TRUNCATE … CASCADE` reaches nothing else —
 * `operator-cli.integration.test.ts` fails the day one does.
 *
 * The connectors' links (`api_connector_links`) go because the id counters
 * restart: each link names a local record by its permanent id, deliberately
 * without a foreign key, and after the wipe that id belongs to whatever record
 * is created next. A kept link would make the connector's next run skip that
 * unrelated record (the remote row's hash is unchanged) or overwrite it with
 * the remote's fields.
 *
 * The activity log goes with a wipe on purpose: every entry in it describes a
 * record the wipe removes. No ordinary write can remove an entry — its row
 * triggers refuse every UPDATE and DELETE — but a TRUNCATE fires no row
 * trigger, so the wipe empties it, and the hash chain starts again from genesis
 * with the next write. On a live database that is the audit trail
 * disappearing, so the console says so, with the count, before it happens.
 * `reload:catalog` is not a wipe and leaves the trail alone.
 *
 * Image files on disk are left alone: with their rows gone, the Master's
 * startup sweep (`sweepOrphanImageVariants`) removes them on its next boot.
 *
 * **Run it with the Master stopped.** This is a separate process: nothing it
 * does reaches the running Master's hub, change ring or caches, and on the
 * bundled cluster stopping the cluster at exit would pull the database out
 * from under that Master. `reload:catalog` refuses outright while anything
 * else is connected; starting the Master afterwards mints a new `BOOT_ID`,
 * which is what makes every panel take a fresh snapshot. With `DATABASE_URL`
 * set it uses that server instead and stops nothing — which is how the
 * integration test runs it.
 *
 * Never imported by app code or tests; the test runs it as a process.
 */
import { PERMISSIONS, type PartyInput, type PermissionSet } from '@orderbook/shared';

import { closeDatabase, db, initDatabase, runMigrations } from '../db/knex.js';
import { startPostgres } from '../db/postgres-server.js';
import { createLogger } from '../lib/logger.js';
import type { ActorContext } from '../domain/actor.js';
import { createParty } from './catalog.service.js';
import {
  loadCatalogue,
  otherDatabaseClients,
  readCatalogueFile,
  seedCatalogue,
} from './catalogue-seed.service.js';

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
  'api_connector_links',
  'activity_log',
  // Notices point at records this wipes, so they go with them.
  'user_notifications',
  // So do chat record chips, which name leads and orders by id (ids restart below).
  'chat_messages',
  'chat_members',
  'chat_rooms',
];

const SAMPLE_PARTIES: PartyInput[] = [
  { name: 'Patel Tiles & Sanitary', phone: '9876543210', city: 'Morbi', state: 'Gujarat', notes: 'Sample dealer' },
  { name: 'Shree Balaji Traders', phone: '9123456780', city: 'Rajkot', state: 'Gujarat' },
  { name: 'New Home Ceramics', city: 'Ahmedabad', state: 'Gujarat' },
];

/**
 * Demo dealers for trying the lead flow on a live install. Unlike
 * `seed:parties` this wipes nothing: a party whose name is already on the
 * books (any case) is left alone, so running it twice adds nothing twice.
 * Phone numbers are the obviously-fake 90000 000xx series.
 */
const DEMO_PARTIES: PartyInput[] = [
  ...SAMPLE_PARTIES,
  {
    name: 'Jay Ambe Sanitary Stores',
    phone: '9000000011',
    addressLine1: 'Station Road',
    city: 'Thangadh',
    state: 'Gujarat',
    pincode: '363530',
    notes: 'Demo dealer',
  },
  {
    name: 'Krishna Bath Fittings',
    phone: '9000000012',
    city: 'Surat',
    state: 'Gujarat',
    pincode: '395003',
    notes: 'Demo dealer',
  },
  {
    name: 'Mahalaxmi Hardware & Sanitary',
    phone: '9000000013',
    city: 'Vadodara',
    state: 'Gujarat',
    pincode: '390001',
    notes: 'Demo dealer',
  },
  {
    name: 'Om Sai Ceramic House',
    phone: '9000000014',
    city: 'Pune',
    state: 'Maharashtra',
    pincode: '411002',
    notes: 'Demo dealer',
  },
  {
    name: 'Shiv Shakti Sanitaryware',
    phone: '9000000015',
    city: 'Indore',
    state: 'Madhya Pradesh',
    pincode: '452001',
    notes: 'Demo dealer',
  },
  {
    name: 'Royal Tiles & Bath Studio',
    phone: '9000000016',
    email: 'demo.royal@example.com',
    city: 'Jaipur',
    state: 'Rajasthan',
    pincode: '302001',
    notes: 'Demo dealer',
  },
  {
    name: 'Ganesh Traders',
    phone: '9000000017',
    city: 'Nashik',
    state: 'Maharashtra',
    pincode: '422001',
    notes: 'Demo dealer',
  },
  {
    name: 'Umiya Sanitary Mart',
    phone: '9000000018',
    city: 'Mehsana',
    state: 'Gujarat',
    pincode: '384001',
    notes: 'Demo dealer',
  },
  {
    name: 'Bharat Building Materials',
    phone: '9000000019',
    city: 'Udaipur',
    state: 'Rajasthan',
    pincode: '313001',
    notes: 'Demo dealer',
  },
  {
    name: 'Sunrise Home Décor',
    phone: '9000000020',
    city: 'Bhopal',
    state: 'Madhya Pradesh',
    pincode: '462001',
    notes: 'Demo dealer',
  },
];

async function main(): Promise<void> {
  const reload = process.argv.includes('--catalogue');
  const demoParties = process.argv.includes('--demo-parties');
  const withCatalog = process.argv.includes('--with-catalog');
  const withParties = process.argv.includes('--with-parties');

  // Parsed before the database is even started: a file the parser refuses
  // must never get as far as a delete.
  const catalogue = reload ? await readCatalogueFile() : null;

  const handle = await startPostgres();

  if (reload) {
    // Thrown before the `try`, so `handle.stop()` never runs: somebody is
    // using this cluster, and on the bundled one `startPostgres` just adopted it.
    // ponytail: check-then-act — a Master started mid-run is not caught; the
    // lock that would catch it has to be held by the Master itself.
    const others = await otherDatabaseClients(handle.connectionUrl);
    if (others.length > 0) {
      throw new Error(
        `Refusing to reload: ${others.length} other connection(s) to this database (${others.join(', ')}). ` +
          'Stop the Master Panel and anything else connected, run this again, then start the Master — ' +
          'its restart makes every panel take a fresh snapshot.',
      );
    }
  }

  initDatabase(handle.connectionUrl);

  try {
    await runMigrations();
    const tenantRow = await db()('tenants').orderBy('created_at').first<{ id: string }>('id');
    if (!tenantRow) throw new Error('No tenant — run first-time setup before reloading the catalogue');
    const tenantId = tenantRow.id;

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
      actorName: 'Catalogue reload',
    };

    if (catalogue) {
      // It cannot see them: an outbox lives on each Office PC. A lead queued
      // there offline names sub products this deletes, and is refused the
      // moment the panel reconnects.
      log.warn(
        'Every Office panel must have synced its outbox (nothing pending) before a reload — ' +
          'queued offline work that quotes the old catalogue will be refused afterwards.',
      );

      const result = await loadCatalogue(catalogue, actor, { replace: true });
      log.info(
        `Catalogue reloaded: ${result.products} products, ${result.subProducts} sub products, ` +
          `${catalogue.brands.length} brands, ${catalogue.colours.length} colours; ` +
          `removed ${result.removedLeads} leads and ${result.removedOrders} orders. ` +
          'Parties and the activity log were kept. Start the Master now: every panel takes the ' +
          'new catalogue when it reconnects.',
      );
      return;
    }

    if (demoParties) {
      const existing = new Set(
        (
          await db()('parties')
            .where({ tenant_id: tenantId })
            .whereNull('deleted_at')
            .pluck<string[]>('name')
        ).map((name) => name.trim().toLowerCase()),
      );
      let added = 0;
      for (const input of DEMO_PARTIES) {
        if (existing.has(input.name.toLowerCase())) {
          log.info(`Party kept: ${input.name} (already on the books)`);
          continue;
        }
        const party = await createParty(input, actor);
        added += 1;
        log.info(`Party created: ${party.partyCode} ${party.name}`);
      }
      log.info(
        `Demo parties: ${added} added, ${DEMO_PARTIES.length - added} already on the books.`,
      );
      return;
    }

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
      // Named one by one so the pending order series (`po:<fy>`) is never
      // among them: a PO number once printed is never handed out again, even
      // after the business data is erased. Only a developer factory reset
      // starts those series over.
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
        'chat_message',
      ]) {
        await trx('id_sequences').where({ tenant_id: tenantId, entity }).update({ next_value: 1 });
      }
      await trx('master_clock').where({ id: 1 }).update({ physical: 0, counter: 0 });
    });
    log.info('Business data and the activity log erased; users, roles, settings and panels kept.');

    if (withCatalog) {
      const result = await seedCatalogue({ actor });
      log.info(
        `Catalogue loaded: products=${result.products} subProducts=${result.subProducts} skipped=${result.skipped}`,
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
