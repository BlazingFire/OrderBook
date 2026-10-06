/**
 * Bulk party import and export, end to end against PostgreSQL.
 *
 * What a unit test cannot see: that a file with bad rows imports the others
 * and names exactly the bad ones; that a dry run writes nothing and re-checks
 * the same way the real run does; that one activity row and one `party_bulk`
 * event come out of a whole file; that an export uploaded back with "update by
 * code" changes nothing, as CSV and as XLSX; and that Party Access still holds
 * — an export lists only the caller's parties, and a code the caller cannot
 * manage is a row error, never a write.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { canRunIntegrationTests } from './helpers/db.js';
import { actorWith, resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';
import { db } from '../src/db/knex.js';
import type { ActorContext } from '../src/domain/actor.js';
import { ForbiddenError, ValidationError } from '../src/lib/errors.js';
import { readSheetRows } from '../src/lib/spreadsheet.js';
import { resetChangeRing, since } from '../src/realtime/change-ring.js';
import * as catalog from '../src/services/catalog.service.js';
import * as partyAccess from '../src/services/party-access.service.js';
import * as roleService from '../src/services/role.service.js';
import * as userService from '../src/services/user.service.js';
import { exportParties, importParties, partyImportTemplate } from '../src/services/party-import.service.js';

let admin: ActorContext;

function csv(rows: string[][], fileName = 'parties.csv'): { buffer: Buffer; fileName: string } {
  const text = rows.map((row) => row.join(',')).join('\r\n') + '\r\n';
  return { buffer: Buffer.from(text, 'utf8'), fileName };
}

function run(
  file: { buffer: Buffer; fileName: string },
  mode: 'create' | 'updateByCode' = 'create',
  dryRun = false,
  actor = admin,
) {
  return importParties(file, { dryRun, mode }, actor);
}

const HEAD = ['Party Code', 'Name', 'Phone', 'City', 'Pincode', 'GST Number'];

const DESK_KEYS = ['parties.view', 'parties.create', 'parties.edit', 'parties.bulk', 'parties.export'] as const;

async function makePerson(username: string): Promise<string> {
  const role = await roleService.createRole({ name: `Desk ${username}`, tier: 'management', permissions: [...DESK_KEYS] }, admin);
  const { user } = await userService.createUser({ username, displayName: username, roleId: role.id }, admin);
  return user.id;
}

async function desk(userId: string): Promise<ActorContext> {
  const actor = await actorWith([...DESK_KEYS]);
  return { ...actor, actorId: userId, userId };
}

async function byName(): Promise<Map<string, Awaited<ReturnType<typeof catalog.listParties>>['items'][number]>> {
  const page = await catalog.listParties({ limit: 200 }, admin);
  return new Map(page.items.map((party) => [party.name, party]));
}

describe.skipIf(!canRunIntegrationTests)('bulk party import (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    resetChangeRing();
    admin = await testActor();
  });

  it('adds the parties in a valid file, with one activity row and one party_bulk event', async () => {
    const result = await run(
      csv([
        HEAD,
        ['', 'Shah Ceramics', '98250 11111', 'Morbi', '363641', '24ABCDE1234F1Z5'],
        ['', 'Patel Traders', '', 'Rajkot', '', ''],
        ['', 'Mehta Tiles', '', '', '', ''],
      ]),
    );

    expect(result).toMatchObject({ dryRun: false, mode: 'create', totalRows: 3, created: 3, updated: 0, skipped: 0, failed: 0, issues: [] });

    const parties = await byName();
    expect(parties.get('Shah Ceramics')).toMatchObject({ phone: '98250 11111', city: 'Morbi', pincode: '363641', gstNumber: '24ABCDE1234F1Z5' });
    expect(parties.get('Mehta Tiles')?.partyCode).toMatch(/^P-\d{4,}$/);

    const activity = await db()('activity_log').where({ entity_type: 'party_list', action: 'imported' });
    expect(activity).toHaveLength(1);
    expect(activity[0].details).toMatchObject({ count: 3, fileName: 'parties.csv', mode: 'create' });
    // One event for the file, not one `party` event per row.
    expect(await db()('activity_log').where({ entity_type: 'party' })).toHaveLength(0);
    expect((since(0) ?? []).map((event) => event.entity)).toEqual(['party_bulk']);
  });

  it('names exactly the bad rows, skips a party that exists, and imports the rest', async () => {
    await catalog.createParty({ name: 'Old Customer', city: 'Surat' }, admin);

    const result = await run(
      csv([
        HEAD,
        ['', 'Good One', '', 'Morbi', '', ''], // row 2: fine
        ['', '', '', 'Morbi', '', ''], // row 3: no name
        ['', 'Bad Pin', '', 'Morbi', '3636', ''], // row 4: pincode not six digits
        ['', 'old customer', '', ' SURAT ', '', ''], // row 5: already there, case and spacing aside
        ['P-0001', 'Has Code', '', '', '', ''], // row 6: a code on a create
        ['', 'Good One', '', 'Morbi', '', ''], // row 7: repeats row 2
        ['', 'Good Two', '', '', '', 'NOTAGSTIN'], // row 8: GSTIN wrong
      ]),
    );

    expect(result).toMatchObject({ totalRows: 7, created: 1, failed: 5, skipped: 1 });
    expect(result.issues.map((issue) => [issue.row, issue.kind, issue.messageKey])).toEqual([
      [3, 'error', 'validation.party.nameRequired'],
      [4, 'error', 'validation.party.pincodeInvalid'],
      [5, 'skipped', 'import.skip.partyExists'],
      [6, 'error', 'validation.import.partyCodeNotAllowed'],
      [7, 'error', 'validation.import.duplicateInFile'],
      [8, 'error', 'validation.party.gstInvalid'],
    ]);
    expect([...(await byName()).keys()].sort()).toEqual(['Good One', 'Old Customer']);
  });

  it('writes nothing on a dry run, and reports what the real run then does', async () => {
    const file = csv([HEAD, ['', 'Dry Run Co', '', 'Morbi', '', ''], ['', '', '', '', '', '']]);
    const dry = await run(file, 'create', true);

    expect(dry).toMatchObject({ dryRun: true, totalRows: 1, created: 1 });
    expect((await catalog.listParties({}, admin)).total).toBe(0);
    expect(since(0)).toEqual([]);
    expect(await db()('activity_log').where({ entity_type: 'party_list' })).toHaveLength(0);

    const real = await run(file);
    expect(real).toMatchObject({ dryRun: false, created: 1, failed: 0 });
    expect((await catalog.listParties({}, admin)).total).toBe(1);
  });

  it('leaves everything alone when the same file is imported twice', async () => {
    const file = csv([HEAD, ['', 'Once Only', '', 'Morbi', '', '']]);
    await run(file);
    const again = await run(file);

    expect(again).toMatchObject({ created: 0, skipped: 1, failed: 0 });
    expect((await catalog.listParties({}, admin)).total).toBe(1);
  });

  describe('updating by code', () => {
    it('changes only the cells it fills, reports an unknown code, and counts an identical row as unchanged', async () => {
      const shah = await catalog.createParty({ name: 'Shah Ceramics', phone: '111', city: 'Morbi', email: 'shah@example.in' }, admin);
      const patel = await catalog.createParty({ name: 'Patel Traders', phone: '222' }, admin);

      const result = await run(
        csv([
          ['Party Code', 'Name', 'Phone', 'City'],
          [shah.partyCode, '', '999999', ''], // phone changes; name and city untouched
          [patel.partyCode, 'Patel Traders', '222', ''], // says what is already there
          ['P-9999', 'Nobody', '', ''], // no such party
        ]),
        'updateByCode',
      );

      expect(result).toMatchObject({ totalRows: 3, created: 0, updated: 1, unchanged: 1, failed: 1 });
      expect(result.issues.map((issue) => [issue.row, issue.messageKey, issue.params])).toEqual([
        [4, 'validation.import.partyCodeUnknown', { code: 'P-9999' }],
      ]);

      const after = await catalog.getParty(shah.id, admin);
      expect(after).toMatchObject({ name: 'Shah Ceramics', phone: '999999', city: 'Morbi', email: 'shah@example.in' });
      expect(after.sync.version).toBe(shah.sync.version + 1);
      expect((await catalog.getParty(patel.id, admin)).sync.version).toBe(patel.sync.version);
      expect(await db()('activity_log').where({ entity_type: 'party_list', action: 'imported' })).toHaveLength(1);
    });

    it('needs a Party Code column, and a code on every row', async () => {
      await expect(run(csv([['Name'], ['x']]), 'updateByCode')).rejects.toMatchObject({
        messageKey: 'validation.import.missingColumn',
        params: { column: 'Party Code' },
      });

      const result = await run(csv([['Party Code', 'Name'], ['', 'No code']]), 'updateByCode');
      expect(result.issues.map((issue) => issue.messageKey)).toEqual(['validation.import.partyCodeRequired']);
    });

    it('does not re-judge a loose pincode the sheet did not change', async () => {
      const party = await catalog.createParty({ name: 'Old Data', pincode: '3636' }, admin);
      const result = await run(csv([['Party Code', 'Pincode'], [party.partyCode, '3636']]), 'updateByCode');
      expect(result).toMatchObject({ failed: 0, unchanged: 1 });
    });
  });

  describe('export, then import it back', () => {
    it('is a round trip as CSV: update by code finds nothing to change', async () => {
      await catalog.createParty({ name: 'Shah, Ceramics', phone: '0731-222', city: 'Morbi', pincode: '363641', notes: 'line one\nline two' }, admin);
      await catalog.createParty({ name: 'Patel Traders', gstNumber: '24ABCDE1234F1Z5', addressLine1: '=SUM(A1)' }, admin);

      const file = await exportParties('csv', admin);
      expect(file.fileName).toMatch(/^parties-\d{4}-\d{2}-\d{2}\.csv$/);
      expect(file.bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));

      const again = await run({ buffer: file.bytes, fileName: file.fileName }, 'updateByCode');
      expect(again).toMatchObject({ totalRows: 2, updated: 0, unchanged: 2, failed: 0, issues: [] });
      expect(await db()('activity_log').where({ entity_type: 'party_list', action: 'exported' })).toHaveLength(1);
    });

    it('is a round trip as XLSX, with the sheet named Parties and text kept as text', async () => {
      await catalog.createParty({ name: 'Zero Phone', phone: '0731222', pincode: '363641' }, admin);

      const file = await exportParties('xlsx', admin);
      const rows = await readSheetRows(file.bytes);
      expect(rows[0]).toEqual(['Party Code', 'Name', 'Phone', 'Alt Phone', 'Email', 'Address Line 1', 'Address Line 2', 'City', 'State', 'Pincode', 'GST Number', 'Notes']);
      expect(rows[1]?.[2]).toBe('0731222');

      const again = await run({ buffer: file.bytes, fileName: file.fileName }, 'updateByCode');
      expect(again).toMatchObject({ updated: 0, unchanged: 1, failed: 0 });
    });

    it('exports every party of a big book, past one page', async () => {
      const rows = Array.from({ length: 1234 }, (_, index) => ['', `Party ${String(index).padStart(4, '0')}`, '', '', '', '']);
      const result = await run(csv([HEAD, ...rows]));
      expect(result.created).toBe(1234);

      const exported = await readSheetRows((await exportParties('xlsx', admin)).bytes);
      expect(exported).toHaveLength(1235);
    });
  });

  describe('files', () => {
    it('refuses what is not a spreadsheet, an empty file, and a file with too many rows', async () => {
      await expect(run({ buffer: Buffer.from('x'), fileName: 'parties.pdf' })).rejects.toMatchObject({ messageKey: 'validation.import.unsupportedFormat' });
      await expect(run(csv([[]]))).rejects.toBeInstanceOf(ValidationError);
      await expect(run(csv([['Name']]))).rejects.toMatchObject({ messageKey: 'validation.import.emptyFile' });

      const many = Array.from({ length: 5001 }, (_, index) => [`Party ${index}`]);
      await expect(run(csv([['Name'], ...many]))).rejects.toMatchObject({ messageKey: 'validation.import.tooManyRows', params: { max: 5000 } });
    });

    it('serves the template as CSV and XLSX', async () => {
      const asCsv = await partyImportTemplate('csv', admin);
      expect(asCsv.bytes.toString('utf8').replace(/^\uFEFF/, '')).toBe(
        'Party Code,Name,Phone,Alt Phone,Email,Address Line 1,Address Line 2,City,State,Pincode,GST Number,Notes\r\n',
      );
      const asXlsx = await partyImportTemplate('xlsx', admin);
      expect(asXlsx.fileName).toBe('parties-template.xlsx');
      expect((await readSheetRows(asXlsx.bytes))[0]?.[1]).toBe('Name');
    });
  });

  describe('permissions', () => {
    it('needs parties.bulk plus create (to add) or edit (to update); export needs parties.view and parties.export', async () => {
      const file = csv([HEAD, ['', 'Nobody', '', '', '', '']]);

      await expect(run(file, 'create', false, await actorWith(['parties.create']))).rejects.toBeInstanceOf(ForbiddenError);
      await expect(run(file, 'create', false, await actorWith(['parties.bulk']))).rejects.toBeInstanceOf(ForbiddenError);
      await expect(run(file, 'updateByCode', false, await actorWith(['parties.bulk', 'parties.create']))).rejects.toBeInstanceOf(ForbiddenError);
      await expect(partyImportTemplate('csv', await actorWith(['parties.view']))).rejects.toBeInstanceOf(ForbiddenError);
      await expect(exportParties('csv', await actorWith(['parties.bulk']))).rejects.toBeInstanceOf(ForbiddenError);

      // Seeing the book is not being handed all of it in a file.
      await expect(exportParties('csv', await actorWith(['parties.view']))).rejects.toMatchObject({
        details: { permission: 'parties.export' },
      });
      await expect(exportParties('xlsx', await actorWith(['parties.export']))).rejects.toMatchObject({
        details: { permission: 'parties.view' },
      });

      const exporter = await actorWith(['parties.view', 'parties.export']);
      await expect(exportParties('csv', exporter)).resolves.toMatchObject({ contentType: 'text/csv; charset=utf-8' });
    });
  });

  describe('Party Access', () => {
    it('exports only the parties the caller may view, and never lets a row reach one it may not', async () => {
      const mine = await makePerson('mine');
      const theirs = await makePerson('theirs');
      const open = await catalog.createParty({ name: 'Open Traders', city: 'Morbi' }, admin);
      const closedForMe = await catalog.createParty({ name: 'Theirs Only', city: 'Surat' }, admin);
      const readOnly = await catalog.createParty({ name: 'Read Only Co', city: 'Surat' }, admin);

      await partyAccess.replaceAssignments(closedForMe.id, { entries: [{ userId: theirs, level: 'manage' }], expectedVersion: closedForMe.sync.version }, admin);
      await partyAccess.replaceAssignments(readOnly.id, { entries: [{ userId: mine, level: 'view' }], expectedVersion: readOnly.sync.version }, admin);

      const me = await desk(mine);
      const exported = await readSheetRows((await exportParties('xlsx', me)).bytes);
      expect(exported.slice(1).map((row) => row[1]).sort()).toEqual(['Open Traders', 'Read Only Co']);

      const result = await run(
        csv([
          ['Party Code', 'Phone'],
          [open.partyCode, '111111'], // open: allowed
          [closedForMe.partyCode, '222222'], // not visible to me: reported as unknown
          [readOnly.partyCode, '333333'], // visible, not manageable: refused by name
        ]),
        'updateByCode',
        false,
        me,
      );

      expect(result).toMatchObject({ updated: 1, failed: 2 });
      expect(result.issues.map((issue) => [issue.row, issue.messageKey])).toEqual([
        [3, 'validation.import.partyCodeUnknown'],
        [4, 'validation.import.partyOutOfScope'],
      ]);
      expect((await catalog.getParty(closedForMe.id, admin)).phone).toBeNull();
      expect((await catalog.getParty(readOnly.id, admin)).phone).toBeNull();
      expect((await catalog.getParty(open.id, admin)).phone).toBe('111111');
    });

    it('treats a party the caller cannot see as not existing: no "already there" answer that would confirm it, and the copy is the caller’s alone', async () => {
      const mine = await makePerson('mine');
      const theirs = await makePerson('theirs');
      const closed = await catalog.createParty({ name: 'Theirs Only', city: 'Surat' }, admin);
      await partyAccess.replaceAssignments(closed.id, { entries: [{ userId: theirs, level: 'manage' }], expectedVersion: closed.sync.version }, admin);

      const result = await run(csv([HEAD, ['', 'Theirs Only', '', 'Surat', '', '']]), 'create', false, await desk(mine));

      expect(result).toMatchObject({ created: 1, skipped: 0 });
      expect((await catalog.listParties({}, admin)).total).toBe(2);
      expect((await catalog.listParties({}, await desk(mine))).total).toBe(1);
      expect((await catalog.listParties({}, await desk(theirs))).total).toBe(1);
    });
  });
});
