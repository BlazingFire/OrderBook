/**
 * A whole restore truncates with `RESTART IDENTITY` and then re-inserts the
 * dumped rows carrying their original keys — a combination Postgres does not
 * self-correct, because supplying a serial column's value never advances its
 * sequence. The restore reports success and the *next* audited write is the one
 * that dies, on a duplicate primary key, inside the business transaction it was
 * required to share. The display-code sequences go wrong the other way round:
 * nothing owns them, so `RESTART IDENTITY` skips them and a restore onto a fresh
 * install hands out `P-0001` for a second time.
 *
 * Neither is visible at restore time, and neither is visible to the compiler, so
 * this drives the real dump/truncate/load round trip and then asks the sequences
 * what they intend to hand out next. The transaction is rolled back at the end:
 * a whole restore empties every table, including the ones the migrations seeded.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';
import { db } from '../src/db/knex.js';
import * as activityLog from '../src/repositories/activity-log.repository.js';
import {
  dumpTable,
  listUserTables,
  loadTables,
  tenantScopedTables,
} from '../src/repositories/backup.repository.js';
import * as catalog from '../src/services/catalog.service.js';

/** Rolls the restore back without the failure looking like a test failure. */
class Rollback extends Error {}

describe.skipIf(!canRunIntegrationTests)('restore sequence resync (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(resetData);

  it('leaves every sequence past the rows the restore reinstated', async () => {
    const actor = await testActor();
    const party = await catalog.createParty({ name: 'Restore Test Traders' }, actor);

    await db().transaction((trx) =>
      activityLog.recordActivity(
        {
          tenantId: actor.tenantId,
          entityType: 'party',
          entityId: party.id,
          action: 'created',
          actorType: actor.actorType,
          actorId: actor.actorId,
          details: { partyName: party.name, partyCode: party.partyCode },
        },
        actor,
        trx,
      ),
    );

    let restoredLogIds: number[] = [];
    let nextLogId = 0;
    let nextPartyCode = 0;

    await db()
      .transaction(async (trx) => {
        const tables = await listUserTables(trx);
        const scoped = await tenantScopedTables(trx);

        const payload: Record<string, Record<string, unknown>[]> = {};
        for (const table of tables) {
          payload[table] = await dumpTable(table, null, scoped.has(table), trx);
        }

        restoredLogIds = (payload.activity_log ?? []).map((row) => Number(row.id));
        // Guards the assertions below: an empty log leaves the sequence at 1
        // legitimately, which is exactly the value the defect produced.
        expect(restoredLogIds.length).toBeGreaterThan(0);

        // Round-tripped through JSON first, because that is the shape
        // `restoreBackup` hands over — the gzipped payload, not live driver values.
        await loadTables(trx, tables, scoped, JSON.parse(JSON.stringify(payload)), null);

        const { rows } = await trx.raw<{ rows: [{ log_id: string; party_code: string }] }>(
          `SELECT nextval('activity_log_id_seq') AS log_id, nextval('party_code_seq') AS party_code`,
        );
        nextLogId = Number(rows[0].log_id);
        nextPartyCode = Number(rows[0].party_code);

        throw new Rollback();
      })
      .catch((error) => {
        if (!(error instanceof Rollback)) throw error;
      });

    expect(nextLogId).toBe(Math.max(...restoredLogIds) + 1);
    expect(nextPartyCode).toBe(Number(party.partyCode.slice(2)) + 1);
  });
});
