/**
 * `verifyActivityLogChain` is the gate the whole restore path hangs on: it runs
 * inside the restore transaction, and returning `false` throws
 * `hash_chain_invalid` and rolls the entire restore back.
 *
 * It shipped recomputing the digest in Node with `JSON.stringify(details)`,
 * while the trigger that wrote the digest uses `COALESCE(details::text, '')` —
 * Postgres's own JSONB rendering, which spaces after `:` and `,` and normalises
 * key order. Every `recordActivity` call in the product passes a non-empty
 * `details`, so no real chained row could ever match: restoring a backup of any
 * database that had ever logged anything was impossible, and the failure told
 * the operator their backup had been tampered with.
 *
 * Nothing caught it because nothing exercised restore at all, and a digest
 * mismatch is invisible to both the compiler and a browser. This drives the
 * predicate directly against real rows written by the real trigger — a
 * single-key `details` would very nearly pass by luck, so the fixtures below
 * deliberately use multi-key objects, which is also what the product writes.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { allPermissions } from '@orderbook/shared';

import { canRunIntegrationTests } from './helpers/db.js';
import {
  resetData,
  setUpFirstRun,
  setupDatabase,
  teardownDatabase,
  testActor,
  testTenantId,
} from './helpers/fixtures.js';
import { db } from '../src/db/knex.js';
import * as activityLog from '../src/repositories/activity-log.repository.js';
import { gunzipSync } from 'node:zlib';

import { decryptBackup, readManifest } from '../src/lib/backup-crypto.js';
import { listUserTables, verifyActivityLogChain } from '../src/repositories/backup.repository.js';
import { exportBackup } from '../src/services/backup-export.service.js';
import { restoreBackup } from '../src/services/backup-restore.service.js';

describe.skipIf(!canRunIntegrationTests)('activity log chain verification (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(resetData);

  async function recordSome(): Promise<string> {
    const actor = await testActor();
    const tenantId = await testTenantId();

    await db().transaction(async (trx) => {
      for (const [index, details] of [
        { productId: 'PR0000000001', productName: 'Glossy Floor Tile', boxes: 12 },
        { partyId: 'PA0000000002', partyName: 'Shree Ceramics', creditDays: 30, note: 'first order' },
      ].entries()) {
        await activityLog.recordActivity(
          {
            tenantId,
            entityType: 'product',
            entityId: `PR000000000${index + 1}`,
            action: index === 0 ? 'created' : 'updated',
            actorType: actor.actorType,
            actorId: actor.actorId,
            details,
          },
          actor,
          trx,
        );
      }
    });

    return tenantId;
  }

  it('accepts a chain the trigger itself wrote, with multi-key JSONB details', async () => {
    const tenantId = await recordSome();

    const rows = await db()('activity_log').where({ tenant_id: tenantId }).andWhere('hash', '<>', 'pre-chain');
    // Guards the assertion below: a verifier trivially passes an empty chain.
    expect(rows.length).toBeGreaterThanOrEqual(2);

    await db().transaction(async (trx) => {
      expect(await verifyActivityLogChain(trx, [tenantId])).toBe(true);
    });
  });

  it('rejects a chain whose details were edited underneath the digest', async () => {
    const tenantId = await recordSome();

    await db().transaction(async (trx) => {
      // The table's triggers refuse UPDATE, which is the point of the audit log —
      // so tampering has to be simulated the way a doctored *backup file* would
      // present it: rows loaded with a `details` that no longer matches `hash`.
      // `loadTables` inserts restored rows with their hashes verbatim, exactly
      // like this.
      const [row] = await trx('activity_log')
        .where({ tenant_id: tenantId })
        .andWhere('hash', '<>', 'pre-chain')
        .orderBy('sequence', 'desc')
        .limit(1);
      expect(row).toBeDefined();

      await trx.raw('ALTER TABLE activity_log DISABLE TRIGGER USER');
      await trx('activity_log').where({ id: row.id }).update({ details: JSON.stringify({ tampered: true }) });
      await trx.raw('ALTER TABLE activity_log ENABLE TRIGGER USER');

      expect(await verifyActivityLogChain(trx, [tenantId])).toBe(false);
    });
  });

  it('is vacuously true for no tenants', async () => {
    await db().transaction(async (trx) => {
      expect(await verifyActivityLogChain(trx, [])).toBe(true);
    });
  });
});

/**
 * The password vault must not travel inside a backup, and must not survive a
 * restore.
 *
 * Two different guarantees with one consequence. The export omits the table
 * because its rows are only *encrypted*, and the key that opens them lives in
 * `dataDir/secrets/`, deliberately outside every export — so a stolen
 * `.obbackup` is worth nothing. The restore clears the live table because it
 * reinstates a different set of `users` rows, and a surviving vault entry would
 * be a sealed password keyed to an id that may now mean somebody else.
 */
describe.skipIf(!canRunIntegrationTests)('the password vault and backups (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(resetData);

  const PASSPHRASE = 'a-long-enough-backup-passphrase';

  it('omits the vault from the export and empties it on restore', async () => {
    await setUpFirstRun('Vault Backup Co');
    const tenantId = await testTenantId();

    // `information_schema` sees the table; `listUserTables` must not.
    const visible = await listUserTables();
    expect(visible).not.toContain('user_password_vault');

    await db()('user_password_vault').insert({
      tenant_id: tenantId,
      user_id: 'US0000000001',
      sealed: JSON.stringify({ v: 1, iv: 'AAAA', tag: 'AAAA', ct: 'AAAA' }),
      credential_fingerprint: 'deadbeefdeadbeef',
      key_version: 1,
    });

    const { data } = await exportBackup({ scope: 'whole', passphrase: PASSPHRASE });

    const payload = JSON.parse(
      gunzipSync(await decryptBackup(readManifest(data), PASSPHRASE)).toString('utf8'),
    ) as { tables: Record<string, unknown[]> };

    expect(Object.keys(payload.tables)).not.toContain('user_password_vault');
    // …and the ciphertext is nowhere else in the file either.
    expect(data.toString('latin1')).not.toContain('deadbeefdeadbeef');

    await restoreBackup(data, PASSPHRASE, true);

    const remaining = await db()('user_password_vault').count<{ count: string }>({ count: '*' }).first();
    expect(Number(remaining?.count ?? -1)).toBe(0);
    // The restore itself worked — this is not passing because everything is gone.
    expect(await db()('tenants').count<{ count: string }>({ count: '*' }).first()).toMatchObject({
      count: '1',
    });
  });
});

/**
 * Notices are left out of a backup too, since they point at user ids a restore
 * may give to somebody else. A selected restore deletes users with the
 * foreign-key cascade switched off, so the restore has to clear them itself.
 */
describe.skipIf(!canRunIntegrationTests)('notices and a selected restore (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(resetData);

  it("clears the restored company's notices", async () => {
    await setUpFirstRun('Notice Backup Co');
    const tenantId = await testTenantId();
    const user = await db()('users').where({ tenant_id: tenantId }).first<{ id: string }>('id');
    await db()('user_notifications').insert({ tenant_id: tenantId, user_id: user!.id, kind: 'panel.offlineLong' });

    const { data } = await exportBackup({
      scope: 'selected',
      tenantIds: [tenantId],
      passphrase: 'a-long-enough-backup-passphrase',
    });
    await restoreBackup(data, 'a-long-enough-backup-passphrase', true);

    expect(await db()('user_notifications').count<{ count: string }>({ count: '*' }).first()).toMatchObject({
      count: '0',
    });
    expect(await db()('users').where({ id: user!.id }).first()).toBeTruthy();
  });
});

/**
 * A backup from before 1.3 has no Server Master role, and the migration that
 * seeds it has already run on the database being restored into, so the
 * restore itself has to put the role back.
 */
describe.skipIf(!canRunIntegrationTests)('restoring a backup without a Server Master role (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(resetData);

  const PASSPHRASE = 'a-long-enough-backup-passphrase';

  it('recreates exactly one system Server Master role holding every permission', async () => {
    await setUpFirstRun('Old Backup Co');
    // Stand in for a pre-1.3 database: no role carries the Server Master tier.
    await db()('roles').where({ tier: 'server_master' }).update({ tier: 'admin' });
    const { data } = await exportBackup({ scope: 'whole', passphrase: PASSPHRASE });

    await restoreBackup(data, PASSPHRASE, true);

    const roles = await db()('roles')
      .where({ tier: 'server_master' })
      .select<Array<{ is_system: boolean; permissions: string[] }>>('is_system', 'permissions');
    expect(roles).toHaveLength(1);
    expect(roles[0]!.is_system).toBe(true);
    expect([...roles[0]!.permissions].sort()).toEqual([...allPermissions()].sort());
  });
});
