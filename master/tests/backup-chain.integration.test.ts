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

import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor, testTenantId } from './helpers/fixtures.js';
import { db } from '../src/db/knex.js';
import * as activityLog from '../src/repositories/activity-log.repository.js';
import { verifyActivityLogChain } from '../src/repositories/backup.repository.js';

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
