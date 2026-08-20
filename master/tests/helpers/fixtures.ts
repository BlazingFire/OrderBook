/**
 * Shared setup for integration suites: migrate once, then truncate between
 * tests so each starts from a known-empty database without paying for a fresh
 * migration run every time.
 */

import { closeDatabase, db, initDatabase, runMigrations } from '../../src/db/knex.js';
import { startTestPostgres, stopTestPostgres, testConnectionUrl } from './db.js';

export async function setupDatabase(): Promise<void> {
  await startTestPostgres();
  initDatabase(testConnectionUrl());
  await runMigrations();
}

export async function teardownDatabase(): Promise<void> {
  await closeDatabase();
  await stopTestPostgres();
}

/**
 * RESTART IDENTITY resets the display-code sequences too, so every test can
 * assert on P-0001 / L-000001 rather than whatever the previous test left
 * behind.
 */
export async function resetData(): Promise<void> {
  await db().raw(`
    TRUNCATE TABLE
      activity_log, stock_movements, inventory_stock, lead_items, leads,
      product_images, products, product_categories, parties, office_panels,
      users, master_config
    RESTART IDENTITY CASCADE
  `);
  await db().raw(`
    ALTER SEQUENCE party_code_seq RESTART WITH 1;
    ALTER SEQUENCE product_code_seq RESTART WITH 1;
    ALTER SEQUENCE lead_number_seq RESTART WITH 1;
  `);
}
