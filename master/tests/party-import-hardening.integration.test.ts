/**
 * The review's findings on the party import, each pinned where it bit: an
 * export read back is no change, a row that cannot be saved never leaks a
 * database sentence, the audit entry stands or falls with the write it rides
 * on, an export pages through same-named parties without losing one, and the
 * preview of an update shows the party being updated.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';
import { db } from '../src/db/knex.js';
import type { ActorContext } from '../src/domain/actor.js';
import { readSheetRows } from '../src/lib/spreadsheet.js';
import { resetChangeRing, since } from '../src/realtime/change-ring.js';
import * as activityLog from '../src/repositories/activity-log.repository.js';
import * as partyRepo from '../src/repositories/party.repository.js';
import * as catalog from '../src/services/catalog.service.js';
import { exportParties, importParties } from '../src/services/party-import.service.js';

let admin: ActorContext;

function csv(rows: string[][]): { buffer: Buffer; fileName: string } {
  const text = rows.map((row) => row.join(',')).join('\r\n') + '\r\n';
  return { buffer: Buffer.from(text, 'utf8'), fileName: 'parties.csv' };
}

const run = (file: { buffer: Buffer; fileName: string }, mode: 'create' | 'updateByCode' = 'create', dryRun = false) =>
  importParties(file, { dryRun, mode }, admin);

describe.skipIf(!canRunIntegrationTests)('party import hardening (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    resetChangeRing();
    admin = await testActor();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('an export read back is no change', () => {
    it('counts a legacy party with a double space and an address past the cap as unchanged, not as an update', async () => {
      const party = await catalog.createParty({ name: 'Shah Ceramics', city: 'Morbi', pincode: '363641' }, admin);
      // What an older build let through: a double space, an address longer than any column allows, a loose pincode.
      await db()('parties')
        .where({ id: party.id })
        .update({ name: 'Shah  Ceramics', address_line1: 'x'.repeat(250), pincode: '3636', phone: '98250 11111/22222' });

      for (const format of ['csv', 'xlsx'] as const) {
        const file = await exportParties(format, admin);
        const again = await run({ buffer: file.bytes, fileName: file.fileName }, 'updateByCode');
        expect(again, format).toMatchObject({ totalRows: 1, updated: 0, unchanged: 1, failed: 0, issues: [] });
      }

      const after = await catalog.getParty(party.id, admin);
      expect(after).toMatchObject({ name: 'Shah  Ceramics', pincode: '3636' });
      expect(after.addressLine1).toHaveLength(250);
      // The raw edit above does not move the version, and neither may an import that changed nothing.
      expect(after.sync.version).toBe(party.sync.version);
    });

    it('still refuses a changed value that breaks a rule, and applies one that does not', async () => {
      const party = await catalog.createParty({ name: 'Old Data', city: 'Morbi' }, admin);
      await db()('parties').where({ id: party.id }).update({ phone: '98250 11111/22222' });

      const result = await run(
        csv([
          ['Party Code', 'Phone', 'Pincode', 'Email'],
          [party.partyCode, '12345', '3637', 'a@b.in'],
        ]),
        'updateByCode',
      );

      expect(result).toMatchObject({ updated: 0, failed: 1 });
      expect(result.issues.map((issue) => [issue.column, issue.messageKey]).sort()).toEqual(
        [
          ['Phone', 'validation.party.phoneInvalid'],
          ['Pincode', 'validation.party.pincodeInvalid'],
        ].sort(),
      );
      expect((await catalog.getParty(party.id, admin)).email).toBeNull();
    });
  });

  describe('what the preview shows', () => {
    it('is the party being updated, with its code and its own values under the sheet’s changes, keyed by sheet row', async () => {
      const shah = await catalog.createParty({ name: 'Shah Ceramics', city: 'Morbi', phone: '98250 11111' }, admin);
      const patel = await catalog.createParty({ name: 'Patel Traders', city: 'Rajkot', pincode: '360001' }, admin);

      const dry = await run(
        csv([
          ['Party Code', 'Phone'],
          [shah.partyCode, '98250 22222'],
          [patel.partyCode, '98250 33333'],
        ]),
        'updateByCode',
        true,
      );

      expect(dry.sample).toEqual([
        { row: 2, partyCode: shah.partyCode, name: 'Shah Ceramics', city: 'Morbi', phone: '98250 22222' },
        { row: 3, partyCode: patel.partyCode, name: 'Patel Traders', city: 'Rajkot', pincode: '360001', phone: '98250 33333' },
      ]);
    });

    it('has no code on a row that adds a party', async () => {
      const dry = await run(csv([['Name', 'City'], ['New Co', 'Morbi']]), 'create', true);
      expect(dry.sample).toEqual([{ row: 2, partyCode: null, name: 'New Co', city: 'Morbi' }]);
    });
  });

  describe('codes and phones', () => {
    it('says a code that cannot be one of ours is not in the right form, and one that could be is unknown', async () => {
      const result = await run(csv([['Party Code', 'City'], ['Shah', 'x'], ['P-9999', 'x']]), 'updateByCode');
      expect(result.issues.map((issue) => [issue.row, issue.messageKey])).toEqual([
        [2, 'validation.party.codeInvalid'],
        [3, 'validation.import.partyCodeUnknown'],
      ]);
    });

    it('refuses a phone with too few digits or odd characters on a new party, and takes a normal one', async () => {
      const result = await run(
        csv([
          ['Name', 'Phone'],
          ['Good', '98250 11111'],
          ['Short', '12345'],
          ['Odd', '98250abc11'],
        ]),
      );
      expect(result).toMatchObject({ created: 1, failed: 2 });
      expect(result.issues.map((issue) => [issue.row, issue.messageKey])).toEqual([
        [3, 'validation.party.phoneInvalid'],
        [4, 'validation.party.phoneInvalid'],
      ]);
    });
  });

  describe('the skip does not say which party it matched', () => {
    it('is a fixed sentence with no name or city in it', async () => {
      await catalog.createParty({ name: 'Shah Ceramics', city: 'Morbi' }, admin);
      const result = await run(csv([['Name', 'City'], ['Shah Ceramics', 'Morbi']]));
      expect(result.issues).toEqual([
        { row: 2, kind: 'skipped', column: 'Name', messageKey: 'import.skip.partyExists', params: undefined },
      ]);
    });
  });

  describe('the row cap counts data, not blank lines', () => {
    it('takes a sheet formatted far past its last party, and refuses one that really has too many', async () => {
      const padded = csv([['Name'], ['Only One'], ...Array.from({ length: 6000 }, () => [''])]);
      await expect(run(padded)).resolves.toMatchObject({ totalRows: 1, created: 1 });

      const many = csv([['Name'], ...Array.from({ length: 5001 }, (_, index) => [`Party ${index}`])]);
      await expect(run(many)).rejects.toMatchObject({ messageKey: 'validation.import.tooManyRows', params: { max: 5000 } });
    });
  });

  describe('an export pages through same-named parties', () => {
    it('writes every party once even when they all share a name and a page boundary falls among them', async () => {
      const rows = Array.from({ length: 1234 }, (_, index) => ['Same Name', `City ${index}`]);
      const imported = await run(csv([['Name', 'City'], ...rows]));
      expect(imported.created).toBe(1234);

      const file = await exportParties('xlsx', admin);
      const exported = await readSheetRows(file.bytes);
      const codes = exported.slice(1).map((row) => row[0]);
      expect(codes).toHaveLength(1234);
      expect(new Set(codes).size).toBe(1234);
    });
  });

  describe('a row that cannot be saved', () => {
    it('never carries the database’s own sentence: it is logged, and the person reads a fixed one', async () => {
      const real = partyRepo.insertParty;
      let calls = 0;
      vi.spyOn(partyRepo, 'insertParty').mockImplementation(async (party, trx) => {
        calls += 1;
        // The chunk fails as a whole, then each row is replayed; the second row is the bad one.
        if (party.input.name === 'Bad Row') {
          throw Object.assign(new Error('relation "parties" violates secret_constraint_xyz'), { code: 'XX000' });
        }
        return real(party, trx);
      });

      const result = await run(csv([['Name'], ['Fine One'], ['Bad Row'], ['Fine Two']]));

      expect(calls).toBeGreaterThan(3);
      expect(result).toMatchObject({ created: 2, failed: 1 });
      expect(result.issues).toEqual([{ row: 3, kind: 'error', messageKey: 'validation.import.partyRowFailed' }]);
      expect(JSON.stringify(result)).not.toContain('secret_constraint');
    });

    it('names a unique clash and a check failure for what they are', async () => {
      const real = partyRepo.insertParty;
      vi.spyOn(partyRepo, 'insertParty').mockImplementation(async (party, trx) => {
        if (party.input.name === 'Clash') throw Object.assign(new Error('duplicate key value'), { code: '23505' });
        if (party.input.name === 'Check') throw Object.assign(new Error('violates check constraint'), { code: '23514' });
        return real(party, trx);
      });

      const result = await run(csv([['Name'], ['Clash'], ['Check'], ['Fine']]));
      expect(result.created).toBe(1);
      expect(result.issues.map((issue) => [issue.row, issue.messageKey])).toEqual([
        [2, 'validation.import.partyRowConflict'],
        [3, 'validation.import.partyRowInvalid'],
      ]);
    });
  });

  describe('an update stamps clocks from the row as it is when it is written', () => {
    it('keeps the clock of an edit that landed after the file was read', async () => {
      const party = await catalog.createParty({ name: 'Shah Ceramics', city: 'Morbi', phone: '98250 11111' }, admin);
      const stale = await catalog.getParty(party.id, admin);
      expect(stale.sync.fieldHlc).not.toHaveProperty('email');

      // After the import read the party, another writer stamped `email`.
      const realFind = partyRepo.findLivePartiesByCodes;
      vi.spyOn(partyRepo, 'findLivePartiesByCodes').mockImplementation(async (tenantId, codes, runner) => {
        const found = await realFind(tenantId, codes, runner);
        await db()('parties')
          .where({ id: party.id })
          .update({ email: 'late@example.in', field_hlc: JSON.stringify({ ...stale.sync.fieldHlc, email: 'LATE-CLOCK' }) });
        return found;
      });

      const result = await run(csv([['Party Code', 'City'], [party.partyCode, 'Rajkot']]), 'updateByCode');
      expect(result.updated).toBe(1);

      const row = await db()('parties').where({ id: party.id }).first<{ field_hlc: Record<string, string>; email: string; city: string }>();
      expect(row.city).toBe('Rajkot');
      expect(row.email).toBe('late@example.in');
      expect(row.field_hlc.email).toBe('LATE-CLOCK');
      expect(row.field_hlc.city).toBeTruthy();
      expect(row.field_hlc.city).not.toBe('LATE-CLOCK');
    });
  });

  describe('the audit entry rides on the last write', () => {
    it('is one row, written in the same transaction as the last chunk', async () => {
      await run(csv([['Name'], ['One'], ['Two'], ['Three']]));
      const rows = await db()('activity_log').where({ entity_type: 'party_list', action: 'imported' });
      expect(rows).toHaveLength(1);
      expect(rows[0].details).toMatchObject({ count: 3, created: 3, updated: 0 });
    });

    it('leaves nothing half-done when the entry cannot be written: the last write rolls back with it, the rest stands, and the event still goes out', async () => {
      vi.spyOn(activityLog, 'recordActivity').mockRejectedValue(new Error('audit trail unavailable'));

      const result = await run(csv([['Name'], ['One'], ['Two'], ['Three']]));

      // The final write carried the entry, so it failed with it; its row is reported, the others committed.
      expect(result.created).toBe(2);
      expect(result.failed).toBe(1);
      expect(await db()('parties').count<[{ count: string }]>('id as count').first()).toEqual({ count: '2' });
      // Panels are showing the old book either way.
      expect((since(0) ?? []).map((event) => event.entity)).toEqual(['party_bulk']);
    });

    it('is not written at all for a file that changed nothing, and no event goes out', async () => {
      // A row with no name is refused, so nothing is written.
      const result = await run(csv([['Name', 'City'], ['', 'x']]));
      expect(result.created).toBe(0);
      expect(await db()('activity_log').where({ entity_type: 'party_list' })).toHaveLength(0);
      expect(since(0)).toEqual([]);
    });
  });
});
