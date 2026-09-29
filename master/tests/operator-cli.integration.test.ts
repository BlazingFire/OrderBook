/**
 * The operator CLIs, run the way an operator runs them — the command in
 * `master/package.json`, in a process of its own — against the test database.
 *
 * `DATABASE_URL` is what points them here: with it set, `startPostgres()`
 * connects to that server instead of starting (and afterwards stopping) the
 * Master's own cluster. `node --import tsx` is what the `tsx` in each script
 * does, without the per-platform shim (`tsx.cmd` on Windows).
 *
 * What each test pins is a place where a CLI once disagreed with its name:
 * `migrate --status` printed blank pending names (and `Pending: none` for a
 * single pending migration), and `reload:catalog` wiped the business data and
 * loaded nothing. The wipe also empties the activity log, which the audit
 * trail's own row triggers cannot stop; that is intended, so the output has to
 * say so. And it once kept the connectors' links while restarting the id
 * counters those links name records by, so a link came to point at whatever
 * record took its old id.
 *
 * Since catalogue v2 (`docs/catalogue/CATALOGUE_MODEL.md` §4) `reload:catalog`
 * is not a wipe: it replaces the catalogue and keeps parties and the log, and
 * it refuses while anything else — this test's own pool included — is
 * connected. `seed:demo-parties` adds dealers and wipes nothing.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { canRunIntegrationTests, testConnectionUrl } from './helpers/db.js';
import {
  createTestProduct,
  resetData,
  setupDatabase,
  teardownDatabase,
  testActor,
  testTenantId,
} from './helpers/fixtures.js';
import { closeDatabase, db, initDatabase } from '../src/db/knex.js';
import { formatMigrationStatus, type MigrationList } from '../src/db/migration-status.js';
import { migrations, RegistryMigrationSource, type Migration } from '../src/db/migrations/index.js';
import { verifyChain } from '../src/repositories/activity-log.repository.js';
import * as connectorRepo from '../src/repositories/connector.repository.js';
import * as catalog from '../src/services/catalog.service.js';
import * as connectorService from '../src/services/connector.service.js';
import * as roleService from '../src/services/role.service.js';
import * as userService from '../src/services/user.service.js';

const MASTER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = (
  JSON.parse(readFileSync(path.join(MASTER_DIR, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  }
).scripts;

/** Runs `npm run <name> -- <extra…>` in the master workspace, minus npm. */
async function runScript(
  name: string,
  extra: string[] = [],
): Promise<{ code: number | null; output: string }> {
  const [runner, ...args] = (SCRIPTS[name] ?? '').trim().split(/\s+/);
  expect(runner).toBe('tsx');

  const child = spawn(process.execPath, ['--import', 'tsx', ...args, ...extra], {
    cwd: MASTER_DIR,
    env: { ...process.env, DATABASE_URL: testConnectionUrl(), LOG_LEVEL: 'info' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));

  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  return { code, output };
}

async function count(table: string, where?: (query: Knex.QueryBuilder) => void): Promise<number> {
  const query = db()(table);
  where?.(query);
  const row = await query.count('* as n').first<{ n: string }>();
  return Number(row?.n);
}

describe.skipIf(!canRunIntegrationTests)('the operator CLIs (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(async () => {
    await resetData();
    await teardownDatabase();
  });

  describe('migrate --status', () => {
    it('names what Knex reports pending, in the shape Knex really returns it', async () => {
      // One migration the database has not run, appended to the real
      // registry: `list()` hands it back as the source gave it, `{ name, up,
      // down }`, which is the shape the old `m.file` read got wrong.
      const notYetRun: Migration = {
        name: '29990101000000_not_yet_run',
        up: async () => {},
        down: async () => {},
      };
      const source = new RegistryMigrationSource();
      source.getMigrations = async () => [...migrations, notYetRun];

      const list = (await db().migrate.list({ migrationSource: source })) as MigrationList;
      const [applied, pending] = formatMigrationStatus(list);

      expect(pending).toBe('Pending (1): 29990101000000_not_yet_run');
      expect(applied).toContain(`Applied (${migrations.length}): `);
    });

    it('lists every registered migration as applied, and applies nothing', async () => {
      const { code, output } = await runScript('migrate', ['--status']);

      expect(code, output).toBe(0);
      expect(output).toContain(`Applied (${migrations.length}): `);
      for (const migration of migrations) expect(output).toContain(migration.name);
      expect(output).toContain('Pending (0): none');
      // The status path never reaches `runMigrations()`, whose line this is.
      expect(output).not.toContain('Schema already up to date');
    }, 60_000);
  });

  describe('wipe:business', () => {
    let before: Record<string, number>;
    let run: { code: number | null; output: string };
    let linkedProductId = '';

    beforeAll(async () => {
      await resetData();
      const actor = await testActor();

      // Configuration the wipe must keep…
      const role = await roleService.createRole(
        { name: 'Keeper', tier: 'admin', permissions: ['products.view'] },
        actor,
      );
      const keeper = await userService.createUser(
        { username: 'keeper', displayName: 'Keeper', roleId: role.id },
        actor,
      );
      const connector = await connectorService.createConnector(actor, {
        slug: 'kept',
        label: 'Kept connection',
        baseUrl: 'http://127.0.0.1:9',
        authKind: 'none',
        scheduleKind: 'manual',
        runAsUserId: keeper.user.id,
        isEnabled: false,
      });

      // …and business data it must not, each write leaving an activity entry,
      // with the connection's links to it (sync bookkeeping, not configuration).
      const party = await catalog.createParty({ name: 'Wiped Traders', city: 'Morbi' }, actor);
      const { product } = await createTestProduct(actor, {
        name: 'Wiped basin',
        categoryName: 'Wiped category',
      });
      linkedProductId = product.id;
      const tenantId = await testTenantId();
      await connectorRepo.upsertLink(tenantId, connector.id, 'party', {
        remoteId: 'R-PARTY',
        localId: party.id,
        remoteHash: 'unchanged',
      });
      await connectorRepo.upsertLink(tenantId, connector.id, 'product', {
        remoteId: 'R-PRODUCT',
        localId: product.id,
        remoteHash: 'unchanged',
      });

      before = {
        tenants: await count('tenants'),
        users: await count('users'),
        roles: await count('roles'),
        settings: await count('settings'),
        pipelines: await count('pipelines'),
        pipelineStages: await count('pipeline_stages'),
        connectors: await count('api_connectors'),
        activity: await count('activity_log'),
      };
      expect(before.activity).toBeGreaterThan(0);

      run = await runScript('wipe:business');
    }, 180_000);

    it('exits cleanly', () => {
      expect(run.code, run.output).toBe(0);
    });

    it('wipes the business data', async () => {
      expect(await count('parties')).toBe(0);
      expect(await count('products', (query) => query.where({ name: 'Wiped basin' }))).toBe(0);
      expect(
        await count('product_categories', (query) => query.where({ name: 'Wiped category' })),
      ).toBe(0);
    });

    it('loads nothing after it', async () => {
      expect(await count('products')).toBe(0);
      expect(await count('product_categories')).toBe(0);
    });

    it('can reach no table outside its list through CASCADE', async () => {
      // `TRUNCATE … CASCADE` also empties every table holding a foreign key
      // into a truncated one, silently. The list is read from the CLI's
      // source (importing it would run it).
      const source = readFileSync(
        path.join(MASTER_DIR, 'src', 'services', 'catalog-reload-cli.ts'),
        'utf8',
      );
      const block = /const BUSINESS_TABLES = \[([^\]]*)\]/.exec(source)?.[1] ?? '';
      const wiped = [...block.matchAll(/'([a-z_]+)'/g)].map((match) => match[1] as string);
      expect(wiped).toContain('activity_log');

      const { rows } = await db().raw<{ rows: Array<{ referencing: string; referenced: string }> }>(
        `SELECT conrelid::regclass::text AS referencing, confrelid::regclass::text AS referenced
           FROM pg_constraint
          WHERE contype = 'f'
            AND confrelid::regclass::text = ANY(?)
            AND NOT (conrelid::regclass::text = ANY(?))`,
        [wiped, wiped],
      );
      expect(rows).toEqual([]);
    });

    it('keeps the configuration', async () => {
      expect({
        tenants: await count('tenants'),
        users: await count('users'),
        roles: await count('roles'),
        settings: await count('settings'),
        pipelines: await count('pipelines'),
        pipelineStages: await count('pipeline_stages'),
        connectors: await count('api_connectors'),
      }).toEqual({
        tenants: before.tenants,
        users: before.users,
        roles: before.roles,
        settings: before.settings,
        pipelines: before.pipelines,
        pipelineStages: before.pipelineStages,
        connectors: before.connectors,
      });
    });

    it('forgets what a connection linked, because the wipe hands those ids to other records', async () => {
      // The id counters restart at 1, so the wiped product's permanent id goes
      // to the next product created. A link kept past the wipe would make the
      // connection's next run skip that product (the remote row's hash is
      // unchanged) or overwrite it with the remote's fields.
      const { product } = await createTestProduct(await testActor(), { name: 'After the wipe' });
      expect(product.id).toBe(linkedProductId);

      expect(await count('api_connector_links')).toBe(0);
    });

    it('empties the activity log, restarts its chain intact, and says so', async () => {
      // Nothing from before the wipe: the party, the role and the user all
      // logged themselves, and only what was written since remains.
      expect(
        await count('activity_log', (query) =>
          query.whereIn('entity_type', ['party', 'role', 'user']),
        ),
      ).toBe(0);

      const tenantId = await testTenantId();
      const sequences = await db()('activity_log')
        .where({ tenant_id: tenantId })
        .min({ min: 'sequence' })
        .max({ max: 'sequence' })
        .first<{ min: string; max: string }>();
      expect(Number(sequences?.min)).toBe(1);

      const chain = await verifyChain(tenantId, {
        fromSequence: '1',
        toSequence: String(sequences?.max),
      });
      expect(chain.ok).toBe(true);
      expect(chain.checkedCount).toBe(Number(sequences?.max));

      expect(run.output).toMatch(/activity log/i);
      expect(run.output).toContain(`${before.activity} activity entries`);
    });
  });

  describe('reload:catalog', () => {
    let partyId = '';
    let activityBefore = 0;

    beforeAll(async () => {
      await resetData();
      const actor = await testActor();
      partyId = (await catalog.createParty({ name: 'Kept Traders', city: 'Morbi' }, actor)).id;
      await createTestProduct(actor, { name: 'Old basin', categoryName: 'Old range' });
      activityBefore = await count('activity_log');
    });

    it("refuses while anything else is connected — here, this test's own pool — and touches nothing", async () => {
      const { code, output } = await runScript('reload:catalog');

      expect(code, output).not.toBe(0);
      expect(output).toMatch(/Refusing to reload/);
      expect(await count('products', (query) => query.where({ name: 'Old basin' }))).toBe(1);
      expect(await count('activity_log')).toBe(activityBefore);
    }, 120_000);

    it('replaces the catalogue with the shipped file, keeping parties and the whole log', async () => {
      // The one way to be alone on the database from inside the test process.
      await closeDatabase();
      let run: { code: number | null; output: string };
      try {
        run = await runScript('reload:catalog');
      } finally {
        initDatabase(testConnectionUrl());
      }

      expect(run.code, run.output).toBe(0);
      expect(run.output).toMatch(/outbox/);
      expect(await count('products', (query) => query.whereNull('deleted_at'))).toBe(549);
      expect(await count('product_categories', (query) => query.whereNull('deleted_at'))).toBe(41);
      expect(await count('products', (query) => query.where({ name: 'Old basin' }))).toBe(0);
      expect(await count('parties', (query) => query.where({ id: partyId }))).toBe(1);
      // Everything from before, plus the one reload row.
      expect(await count('activity_log')).toBe(activityBefore + 1);
      expect(
        await count('activity_log', (query) =>
          query.where({ entity_type: 'catalog', action: 'reloaded' }),
        ),
      ).toBe(1);
    }, 180_000);
  });

  describe('seed:demo-parties', () => {
    it('adds the thirteen demo dealers, wipes nothing, and adds nothing twice', async () => {
      await resetData();
      await catalog.createParty({ name: 'ganesh traders', city: 'Nashik' }, await testActor());

      const first = await runScript('seed:demo-parties');
      expect(first.code, first.output).toBe(0);
      // Ganesh Traders was already on the books, in another case.
      expect(await count('parties')).toBe(13);

      const second = await runScript('seed:demo-parties');
      expect(second.code, second.output).toBe(0);
      expect(await count('parties')).toBe(13);
      expect(second.output).toContain('0 added');
    }, 180_000);
  });
});
