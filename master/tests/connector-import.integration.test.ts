/**
 * An import against a real remote — a throwaway HTTP server on loopback.
 *
 * A stubbed `fetch` would prove the mapping and nothing else; the things worth
 * testing here are the parts that only exist once a real response comes back:
 * the dry-run gate, the link table, the unchanged-row skip, partial failure,
 * and a flagged field becoming a row on the Conflicts screen.
 *
 * Loopback is deliberately reachable. The shop LAN has no internet and the
 * system this feature exists for runs on the shop PC, so a guard that blocked
 * `127.0.0.1` would block the only target anybody has — only this Master's own
 * origin is refused, which is the recursion guard.
 */

import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { canRunIntegrationTests } from './helpers/db.js';
import { db } from '../src/db/knex.js';
import * as catalogService from '../src/services/catalog.service.js';
import * as connectorService from '../src/services/connector.service.js';
import * as connectorRunService from '../src/services/connector-run.service.js';
import * as roleService from '../src/services/role.service.js';
import * as userService from '../src/services/user.service.js';
import { resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';

let server: Server;
let baseUrl = '';

/** What the fake remote answers with. Rewritten per test. */
let remoteRows: unknown[] = [];

async function startRemote(): Promise<void> {
  server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: remoteRows }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  baseUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
}

async function seedRunner(): Promise<string> {
  const actor = await testActor();
  const role = await roleService.createRole(
    {
      name: 'Importer',
      tier: 'admin',
      permissions: [
        'products.view',
        'products.create',
        'products.edit',
        'field.saleRate.view',
        'field.saleRate.edit',
      ].sort(),
    },
    actor,
  );
  const created = await userService.createUser(
    { username: 'importer', displayName: 'Importer', roleId: role.id },
    actor,
  );
  return created.user.id;
}

async function makeConnector(
  runAsUserId: string,
  onConflict: 'remote_wins' | 'flag' = 'remote_wins',
) {
  const actor = await testActor();

  const connector = await connectorService.createConnector(actor, {
    slug: 'fake',
    label: 'Fake remote',
    baseUrl,
    authKind: 'none',
    scheduleKind: 'manual',
    runAsUserId,
    isEnabled: true,
  });

  return connectorService.setMapping(actor, connector.id, [
    {
      entity: 'product',
      path: '/items',
      remoteIdPointer: '/id',
      itemsPointer: '/data',
      fieldMaps: [
        { localField: 'code', remotePointer: '/sku', transform: 'upper', isRequired: true },
        { localField: 'categoryName', remotePointer: '/category', transform: 'trim' },
        {
          localField: 'name',
          remotePointer: '/name',
          transform: 'trim',
          isRequired: true,
          onConflict,
        },
        { localField: 'rate', remotePointer: '/price', transform: 'rupees_to_paise' },
      ],
    },
  ]);
}

describe.skipIf(!canRunIntegrationTests)('connector import (integration)', () => {
  beforeAll(async () => {
    await setupDatabase();
    await startRemote();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await teardownDatabase();
  });

  beforeEach(async () => {
    await resetData();
    remoteRows = [];
  });

  it('refuses a real import until a dry run at this mapping version exists', async () => {
    const actor = await testActor();
    const connector = await makeConnector(await seedRunner());

    await expect(connectorRunService.runConnector(actor, connector.id, 'import')).rejects.toThrow(
      /dry run/i,
    );
  });

  it('writes nothing on a dry run, then creates and links on the import', async () => {
    const actor = await testActor();
    const connector = await makeConnector(await seedRunner());
    remoteRows = [{ id: 'R-1', sku: 'rst-300', name: 'Rustic 300', price: '125' }];

    const dry = await connectorRunService.runConnector(actor, connector.id, 'dry_run');
    expect(dry.status).toBe('ok');
    expect(dry.created).toBe(1);

    const afterDryRun = await catalogService.listProducts({}, actor);
    expect(afterDryRun.items).toHaveLength(0);

    const imported = await connectorRunService.runConnector(actor, connector.id, 'import');
    expect(imported.created).toBe(1);

    const products = await catalogService.listProducts({}, actor);
    expect(products.items).toHaveLength(1);
    expect(products.items[0]?.variants.map((variant) => variant.code)).toEqual(['RST-300']);
    // Rupees on the wire, paise in the catalogue.
    expect(products.items[0]?.rate).toBe(12_500);

    const links = await db()('api_connector_links').where({ connector_id: connector.id });
    expect(links).toHaveLength(1);
  });

  it('skips an unchanged row on the second run, writing nothing at all', async () => {
    const actor = await testActor();
    const connector = await makeConnector(await seedRunner());
    remoteRows = [{ id: 'R-1', sku: 'RST-300', name: 'Rustic 300', price: '125' }];

    await connectorRunService.runConnector(actor, connector.id, 'dry_run');
    await connectorRunService.runConnector(actor, connector.id, 'import');

    const before = await db()('activity_log').count<[{ count: string }]>({ count: '*' });
    const second = await connectorRunService.runConnector(actor, connector.id, 'import');
    const after = await db()('activity_log').count<[{ count: string }]>({ count: '*' });

    expect(second.skipped).toBe(1);
    expect(second.created).toBe(0);
    expect(second.updated).toBe(0);
    // One entry for the run itself, and none for any record — which is also
    // what closes the echo loop for an `on_change` connector.
    expect(Number(after[0]!.count) - Number(before[0]!.count)).toBe(1);
  });

  it('imports the good rows and reports partial when one is unusable', async () => {
    const actor = await testActor();
    const connector = await makeConnector(await seedRunner());
    remoteRows = [
      { id: 'R-1', sku: 'RST-300', name: 'Rustic 300' },
      // No name: the map marks it required, so this row fails and the other
      // does not. One transaction per row is what makes that possible.
      { id: 'R-2', sku: 'RST-301' },
    ];

    await connectorRunService.runConnector(actor, connector.id, 'dry_run');
    const imported = await connectorRunService.runConnector(actor, connector.id, 'import');

    expect(imported.status).toBe('partial');
    expect(imported.created).toBe(1);
    expect(imported.failed).toBe(1);
    expect(imported.errors[0]?.remoteId).toBe('R-2');
  });

  it('raises a conflict instead of writing when a field says flag', async () => {
    const actor = await testActor();
    const connector = await makeConnector(await seedRunner(), 'flag');
    remoteRows = [{ id: 'R-1', sku: 'RST-300', name: 'Rustic 300' }];

    await connectorRunService.runConnector(actor, connector.id, 'dry_run');
    await connectorRunService.runConnector(actor, connector.id, 'import');

    remoteRows = [{ id: 'R-1', sku: 'RST-300', name: 'Renamed remotely' }];
    await connectorRunService.runConnector(actor, connector.id, 'import');

    const products = await catalogService.listProducts({}, actor);
    // The local name stands; the disagreement is a row somebody resolves.
    expect(products.items[0]?.name).toBe('Rustic 300');

    const conflicts = await db()('sync_conflicts').where({ entity: 'product' });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.field).toBe('name');
    expect(conflicts[0]?.losing_device_code).toBe('CONN:fake');
  });

  it('refuses a connector pointed back at this Master', async () => {
    const actor = await testActor();

    await expect(
      connectorService.createConnector(actor, {
        slug: 'recursive',
        label: 'Itself',
        baseUrl: 'http://127.0.0.1:4100',
        authKind: 'none',
        scheduleKind: 'manual',
      }),
    ).rejects.toThrow();
  });

  it('never returns the credential it was given', async () => {
    const actor = await testActor();

    const connector = await connectorService.createConnector(actor, {
      slug: 'secretive',
      label: 'Secretive',
      baseUrl,
      authKind: 'bearer',
      credential: 'super-secret-token',
      scheduleKind: 'manual',
    });

    expect(connector.credentialConfigured).toBe(true);
    expect(JSON.stringify(connector)).not.toContain('super-secret-token');

    const listed = await connectorService.listConnectors(actor);
    expect(JSON.stringify(listed)).not.toContain('super-secret-token');

    // And it is ciphertext at rest: the column holds a sealed envelope, not the
    // token, so a plain backup dump carries nothing usable.
    const row = await db()('api_connectors')
      .where({ id: connector.id })
      .first<{ credential_sealed: unknown }>('credential_sealed');
    expect(JSON.stringify(row?.credential_sealed)).not.toContain('super-secret-token');
  });
});
