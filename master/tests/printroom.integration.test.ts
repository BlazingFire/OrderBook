/**
 * The Printroom (1.3 Phase 7): sending a frozen note, who sees which jobs, the
 * claim that belongs to a connection, marking and cancelling, the 30-day payload
 * strip, audit, the sender's bell, the REST surface and the migration's grant.
 *
 * Real services on a real database, because most of what matters is an atomic
 * UPDATE (two stations racing for one sheet), a stored row that must not change
 * after the record does, and a per-person answer to the same query.
 */

import type { Permission, PrintJobSummary } from '@orderbook/shared';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { canRunIntegrationTests } from './helpers/db.js';
import {
  actorWith,
  createTestProduct,
  resetData,
  setupDatabase,
  teardownDatabase,
  testActor,
  testTenantId,
} from './helpers/fixtures.js';
import { db } from '../src/db/knex.js';
import type { ActorContext } from '../src/domain/actor.js';
import * as printroomMigration from '../src/db/migrations/20261006000000_printroom.js';
import { createApp } from '../src/http/app.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../src/lib/errors.js';
import { onPrintJob, type PrintJobEvent } from '../src/services/change-bus.js';
import * as catalog from '../src/services/catalog.service.js';
import * as fields from '../src/services/fields.service.js';
import * as leads from '../src/services/lead.service.js';
import * as orders from '../src/services/order.service.js';
import * as partyAccess from '../src/services/party-access.service.js';
import * as print from '../src/services/print.service.js';
import type { PrintOrigin } from '../src/services/print.service.js';
import * as roleService from '../src/services/role.service.js';
import * as userService from '../src/services/user.service.js';

let admin: ActorContext;
let tenantId: string;

const PASSWORD = 'correct-horse';

/** What a sender holds: the right to send and to print the pending order's note. */
const SENDER: Permission[] = ['print.send', 'leads.view', 'leads.export', 'orders.view', 'orders.export'];
const STATION: Permission[] = ['print.station'];

interface Person {
  id: string;
  username: string;
  actor: ActorContext;
}

async function person(username: string, permissions: Permission[], tier: 'office' | 'management' = 'office'): Promise<Person> {
  const role = await roleService.createRole({ name: `Role ${username}`, tier, permissions }, admin);
  const { user } = await userService.createUser(
    { username, displayName: username, roleId: role.id, password: PASSWORD },
    admin,
  );
  const actor = { ...(await actorWith(permissions)), actorId: user.id, userId: user.id, actorName: username };
  return { id: user.id, username, actor };
}

/** A fresh 32-hex request id. */
let counter = 0;
const requestId = (): string => (++counter).toString(16).padStart(32, '0');

/** Where a station's calls come from: its own key and the connection holding its claims. */
const origin = (key: string | null, holder: string | null = key): PrintOrigin => ({ from: key ?? 'lan', stationKey: key, holder });
const FIRST = origin('panel:11111111-1111-4111-8111-111111111111', 'socket-one');
const SECOND = origin('panel:22222222-2222-4222-8222-222222222222', 'socket-two');
const MASTER_PC = origin('master', 'socket-master');
const LAN = origin(null, null);

let seeded = 0;
async function seedLead(name = 'Shree Ceramics', quantity = 3) {
  seeded += 1;
  const party = await catalog.createParty({ name: `${name}${seeded > 1 ? ` ${seeded}` : ''}` }, admin);
  const { product, variant } = await createTestProduct(admin, { name: `Tile ${seeded}`, code: `T-${seeded}` });
  const lead = await leads.createLead(
    { partyId: party.id, items: [{ productId: product.id, variantId: variant.id, quantity, packaging: 'carton' }] },
    admin,
  );
  return { party, lead, product, variant };
}

async function register(key: PrintOrigin, name: string, actor: ActorContext) {
  return print.saveStation({ displayName: name, printerName: 'HP LaserJet', autoPrint: true }, actor, key);
}

async function activityActions(): Promise<string[]> {
  const rows = await db()('activity_log').where({ entity_type: 'print_job' }).orderBy('created_at').select('action');
  return rows.map((row: { action: string }) => row.action);
}

let events: PrintJobEvent[] = [];
let stopListening: () => void;

describe.skipIf(!canRunIntegrationTests)('printroom (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    admin = await testActor();
    tenantId = await testTenantId();
    events = [];
    seeded = 0;
    stopListening = onPrintJob((event) => events.push(event));
  });
  afterEach(() => stopListening());

  describe('sending', () => {
    it('freezes the note the Master builds, with the party header, the PO number and a cleaned vehicle number', async () => {
      const { lead, party } = await seedLead();
      const sender = await person('asha', SENDER);

      const job = await print.sendJob(
        { requestId: requestId(), kind: 'dispatch', source: 'lead', sourceId: lead.id, copies: 3, vehicleNumber: ' gj 01 ab-1234!! ', note: 'Urgent' },
        sender.actor,
        MASTER_PC,
      );

      expect(job).toMatchObject({
        kind: 'dispatch',
        source: 'lead',
        sourceId: lead.id,
        sourceNumber: lead.poNumber,
        partyName: 'Shree Ceramics',
        copies: 3,
        note: 'Urgent',
        status: 'queued',
        requestedFrom: 'master',
        sender: { id: sender.id },
        hasDocument: true,
      });
      expect(job.document).toMatchObject({
        header: { source: 'lead', id: lead.id, number: lead.poNumber },
        partyName: 'Shree Ceramics',
        party: { partyCode: party.partyCode },
        vehicleNumber: 'GJ 01 AB-1234',
      });
      expect(job.document?.model.totalQuantity).toBe(3);
    });

    it('freezes the sender bold tick, falls back to the company switch when none is named, refuses a non-boolean (15x)', async () => {
      const { lead } = await seedLead();
      const sender = await person('bolda', SENDER);

      const unticked = await print.sendJob(
        { requestId: requestId(), kind: 'filling', source: 'lead', sourceId: lead.id, copies: 1, bold: false },
        sender.actor,
        LAN,
      );
      expect(unticked.document?.bold).toBe(false);

      const noTick = await print.sendJob(
        { requestId: requestId(), kind: 'filling', source: 'lead', sourceId: lead.id, copies: 1 },
        sender.actor,
        LAN,
      );
      // `notes.defaultBold` ships true, so a sender naming no tick gets the company default.
      expect(noTick.document?.bold).toBe(true);

      await expect(
        print.sendJob(
          { requestId: requestId(), kind: 'filling', source: 'lead', sourceId: lead.id, copies: 1, bold: 'yes' },
          sender.actor,
          LAN,
        ),
      ).rejects.toMatchObject({ messageKey: 'validation.print.bold' });
    });

    it('prints the current colour label from the list, so a colour renamed in Fields reads the new way on the note', async () => {
      const ivory = await fields.createValue({ listKey: 'stock.colour', value: 'Ivory', label: 'Ivory' }, admin);
      const party = await catalog.createParty({ name: 'Colour Traders' }, admin);
      const product = await catalog.createProduct(
        { name: 'ROMA', categoryName: 'WASH BASIN', multiColour: true, variants: [{ code: 'ROMA-1', weightKg: 12 }] },
        admin,
      );
      const lead = await leads.createLead(
        {
          partyId: party.id,
          items: [{ productId: product.id, variantId: product.variants[0]!.id, quantity: 4, packaging: 'carton', colour: 'Ivory' }],
        },
        admin,
      );
      await fields.updateValue(ivory.id, { label: 'Bone White', expectedVersion: ivory.version }, admin);
      const sender = await person('asha', SENDER);

      const job = await print.sendJob(
        { requestId: requestId(), kind: 'filling', source: 'lead', sourceId: lead.id, copies: 1 },
        sender.actor,
        MASTER_PC,
      );

      expect(job.document?.model.named.map((line) => line.colour)).toEqual(['Bone White']);
    });

    it('keeps the sheet as it was when the record changes afterwards', async () => {
      const { lead, party } = await seedLead();
      const sender = await person('asha', SENDER);
      const job = await print.sendJob(
        { requestId: requestId(), kind: 'filling', source: 'lead', sourceId: lead.id, copies: 1 },
        sender.actor,
        LAN,
      );

      await db()('line_items').where({ parent_type: 'lead', parent_id: lead.id }).update({ quantity: 99 });
      await db()('parties').where({ id: party.id }).update({ name: 'Renamed Traders' });

      const again = await print.getJob(job.id, sender.actor);
      expect(again.document?.model.totalQuantity).toBe(3);
      expect(again.partyName).toBe('Shree Ceramics');
      expect(again.document?.partyName).toBe('Shree Ceramics');
    });

    it('needs print.send and the right to view the record, naming what is missing', async () => {
      const { lead } = await seedLead();
      const order = await orders.convertLead({ leadId: lead.id }, admin);
      const noSend = await person('nosend', ['leads.view', 'orders.view']);
      const noLeadView = await person('noleadview', ['print.send', 'orders.view']);
      const noOrderView = await person('noorderview', ['print.send', 'leads.view']);

      const input = (source: 'lead' | 'order', sourceId: string) => ({ requestId: requestId(), kind: 'filling', source, sourceId, copies: 1 });

      await expect(print.sendJob(input('lead', lead.id), noSend.actor, LAN)).rejects.toMatchObject({ permission: 'print.send' });
      await expect(print.sendJob(input('lead', lead.id), noLeadView.actor, LAN)).rejects.toMatchObject({ permission: 'leads.view' });
      await expect(print.sendJob(input('order', order.id), noOrderView.actor, LAN)).rejects.toMatchObject({ permission: 'orders.view' });
      expect(await db()('print_jobs').count({ count: '*' })).toEqual([{ count: '0' }]);
    });

    it('lets a user with only view rights send, since printing a note is not exporting (1.4 R9/R10)', async () => {
      const { lead } = await seedLead();
      const order = await orders.convertLead({ leadId: lead.id }, admin);
      const viewer = await person('viewer', ['print.send', 'leads.view', 'orders.view']);

      const input = (source: 'lead' | 'order', sourceId: string) => ({ requestId: requestId(), kind: 'filling', source, sourceId, copies: 1 });

      await expect(print.sendJob(input('lead', lead.id), viewer.actor, LAN)).resolves.toMatchObject({ source: 'lead' });
      await expect(print.sendJob(input('order', order.id), viewer.actor, LAN)).resolves.toMatchObject({ source: 'order' });
    });

    it('sends a final order\'s note, with its saved vehicle number when the dialog gave none', async () => {
      const { lead } = await seedLead();
      const order = await orders.convertLead({ leadId: lead.id }, admin);
      await orders.updateOrder(order.id, { vehicleNumber: 'MH 12 XY 1' }, admin);
      const sender = await person('asha', SENDER);

      const job = await print.sendJob(
        { requestId: requestId(), kind: 'dispatch', source: 'order', sourceId: order.id, copies: 2 },
        sender.actor,
        LAN,
      );
      expect(job.document).toMatchObject({ header: { source: 'order', id: order.id }, vehicleNumber: 'MH 12 XY 1' });

      const filling = await print.sendJob(
        { requestId: requestId(), kind: 'filling', source: 'order', sourceId: order.id, copies: 1, vehicleNumber: 'ignored' },
        sender.actor,
        LAN,
      );
      expect(filling.document?.vehicleNumber).toBeNull();
    });

    it('refuses a record the sender\'s Party Access hides, as a missing record', async () => {
      const { lead, party } = await seedLead('Closed Traders');
      const insider = await person('insider', SENDER);
      const outsider = await person('outsider', SENDER);
      await partyAccess.replaceAssignments(
        party.id,
        { entries: [{ userId: insider.id, level: 'manage' }], expectedVersion: party.sync.version },
        admin,
      );
      const input = { requestId: requestId(), kind: 'filling', source: 'lead', sourceId: lead.id, copies: 1 };

      await expect(print.sendJob(input, outsider.actor, LAN)).rejects.toThrow(NotFoundError);
      await expect(print.sendJob({ ...input, requestId: requestId() }, insider.actor, LAN)).resolves.toMatchObject({ status: 'queued' });
    });

    it('returns the same job for a retried request id, announcing and auditing it once', async () => {
      const { lead } = await seedLead();
      const sender = await person('asha', SENDER);
      const input = { requestId: requestId(), kind: 'filling', source: 'lead', sourceId: lead.id, copies: 1 };

      const first = await print.sendJob(input, sender.actor, LAN);
      const retry = await print.sendJob(input, sender.actor, LAN);

      expect(retry.id).toBe(first.id);
      expect(await db()('print_jobs').count({ count: '*' })).toEqual([{ count: '1' }]);
      expect(events).toHaveLength(1);
      expect(await activityActions()).toEqual(['sent']);

      // The same id from somebody else is another send, not theirs to read.
      const other = await person('bina', SENDER);
      const theirs = await print.sendJob(input, other.actor, LAN);
      expect(theirs.id).not.toBe(first.id);
    });

    it.each([
      [{ copies: 0 }, 'validation.print.copies'],
      [{ copies: 51 }, 'validation.print.copies'],
      [{ copies: 2.5 }, 'validation.print.copies'],
      [{ copies: '3' }, 'validation.print.copies'],
      [{ kind: 'invoice' }, 'validation.print.kind'],
      [{ source: 'party' }, 'validation.print.source'],
      [{ requestId: 'nope' }, 'validation.print.requestId'],
      [{ note: 'x'.repeat(201) }, 'validation.print.note'],
      [{ targetStationId: 'not-a-uuid' }, 'validation.print.station'],
      [{ targetStationId: '33333333-3333-4333-8333-333333333333' }, 'validation.print.station'],
    ])('refuses %j', async (override, messageKey) => {
      const { lead } = await seedLead();
      const sender = await person('asha', SENDER);
      await expect(
        print.sendJob(
          { requestId: requestId(), kind: 'filling', source: 'lead', sourceId: lead.id, copies: 1, ...override },
          sender.actor,
          LAN,
        ),
      ).rejects.toMatchObject({ messageKey });
    });
  });

  describe('who sees which jobs', () => {
    it('gives a sender their own jobs and a station holder everyone\'s, with the waiting count', async () => {
      const { lead } = await seedLead();
      const asha = await person('asha', SENDER);
      const bina = await person('bina', SENDER);
      const desk = await person('desk', STATION);
      const both = await person('both', [...SENDER, ...STATION]);
      for (const sender of [asha, asha, bina]) {
        await print.sendJob({ requestId: requestId(), kind: 'filling', source: 'lead', sourceId: lead.id, copies: 1 }, sender.actor, LAN);
      }

      const mine = await print.listJobs({ status: 'waiting' }, asha.actor);
      expect(mine.jobs).toHaveLength(2);
      expect(mine.jobs.every((job) => job.sender?.id === asha.id)).toBe(true);
      expect(mine.waitingCount).toBe(2);

      const all = await print.listJobs({ status: 'waiting' }, desk.actor);
      expect(all.jobs).toHaveLength(3);
      expect(all.waitingCount).toBe(3);

      // A holder of both keys can still ask for only their own.
      expect((await print.listJobs({ status: 'all', mine: true }, both.actor)).jobs).toHaveLength(0);

      // A sender never reads another's job, even by its id.
      const others = await print.listJobs({ status: 'waiting' }, bina.actor);
      await expect(print.getJob(mine.jobs[0]!.id, bina.actor)).rejects.toThrow(NotFoundError);
      expect(others.jobs).toHaveLength(1);
    });

    it('lists the Waiting queue oldest first and pages with a cursor that survives equal times', async () => {
      const { lead } = await seedLead();
      const desk = await person('desk', STATION);
      const sender = await person('asha', SENDER);
      const ids: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        ids.push((await print.sendJob({ requestId: requestId(), kind: 'filling', source: 'lead', sourceId: lead.id, copies: 1 }, sender.actor, LAN)).id);
      }
      // Identical request times: only the id breaks the tie.
      await db()('print_jobs').update({ requested_at: db().raw("timestamptz '2026-10-03 10:00:00+00'") });

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 5; guard += 1) {
        const page: Awaited<ReturnType<typeof print.listJobs>> = await print.listJobs({ status: 'waiting', limit: 2, cursor }, desk.actor);
        seen.push(...page.jobs.map((job) => job.id));
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
      expect([...seen].sort()).toEqual([...ids].sort());
    });

    it('lets a station holder without Party Access see and open a restricted party\'s job (a deliberate cross-party grant)', async () => {
      const { lead, party } = await seedLead('Closed Traders');
      const insider = await person('insider', SENDER);
      const desk = await person('desk', STATION);
      await partyAccess.replaceAssignments(
        party.id,
        { entries: [{ userId: insider.id, level: 'manage' }], expectedVersion: party.sync.version },
        admin,
      );
      const job = await print.sendJob({ requestId: requestId(), kind: 'filling', source: 'lead', sourceId: lead.id, copies: 1 }, insider.actor, LAN);

      const listed = await print.listJobs({ status: 'waiting' }, desk.actor);
      expect(listed.jobs.map((entry) => entry.id)).toEqual([job.id]);
      expect((await print.getJob(job.id, desk.actor)).document?.partyName).toBe('Closed Traders');
    });

    it('refuses someone with neither key', async () => {
      const nobody = await person('nobody', ['leads.view']);
      await expect(print.listJobs({}, nobody.actor)).rejects.toThrow(ForbiddenError);
      await expect(print.listStations(nobody.actor, LAN)).rejects.toThrow(ForbiddenError);
    });
  });

  describe('stations and the claim', () => {
    async function queued() {
      const { lead } = await seedLead();
      const sender = await person('asha', SENDER);
      const job = await print.sendJob({ requestId: requestId(), kind: 'filling', source: 'lead', sourceId: lead.id, copies: 2 }, sender.actor, LAN);
      return { sender, job };
    }

    it('refuses a second station\'s claim while the first is still connected, and releases it when that connection closes', async () => {
      const { job } = await queued();
      const one = await person('one', STATION);
      const two = await person('two', STATION);
      await register(FIRST, 'Front desk', one.actor);
      await register(SECOND, 'Back office', two.actor);

      const won = await print.claimJob(job.id, one.actor, FIRST);
      expect(won).toMatchObject({ id: job.id, status: 'printing', claimedStationName: 'Front desk' });
      expect(won?.document).not.toBeNull();

      // The first is slow but still connected: the second is told no, however long it waits.
      expect(await print.claimJob(job.id, two.actor, SECOND)).toBeNull();
      expect((await print.getJob(job.id, one.actor)).status).toBe('printing');

      await print.releaseClaimsOf('socket-one');
      expect((await print.getJob(job.id, one.actor)).status).toBe('queued');
      expect(await print.claimJob(job.id, two.actor, SECOND)).toMatchObject({ status: 'printing', claimedStationName: 'Back office' });
    });

    it('lets another station take a claim older than ten minutes, but not a fresh one', async () => {
      const { job } = await queued();
      const one = await person('one', STATION);
      const two = await person('two', STATION);
      await register(FIRST, 'Front desk', one.actor);
      await register(SECOND, 'Back office', two.actor);
      await print.claimJob(job.id, one.actor, FIRST);

      await db()('print_jobs').where({ id: job.id }).update({ claimed_at: db().raw("now() - interval '9 minutes'") });
      expect(await print.claimJob(job.id, two.actor, SECOND)).toBeNull();

      await db()('print_jobs').where({ id: job.id }).update({ claimed_at: db().raw("now() - interval '11 minutes'") });
      expect(await print.claimJob(job.id, two.actor, SECOND)).toMatchObject({ status: 'printing', claimedStationName: 'Back office' });
    });

    it('clears every claim at boot', async () => {
      const { job } = await queued();
      const one = await person('one', STATION);
      await register(FIRST, 'Front desk', one.actor);
      await print.claimJob(job.id, one.actor, FIRST);

      await print.releaseAllClaimsAtBoot();

      const row = await db()('print_jobs').where({ id: job.id }).first();
      expect(row).toMatchObject({ status: 'queued', claim_socket: null, claimed_station_id: null, claimed_at: null });
    });

    it('keeps a job aimed at one station from every other', async () => {
      const { lead } = await seedLead();
      const sender = await person('asha', SENDER);
      const one = await person('one', STATION);
      const two = await person('two', STATION);
      const front = await register(FIRST, 'Front desk', one.actor);
      await register(SECOND, 'Back office', two.actor);
      const job = await print.sendJob(
        { requestId: requestId(), kind: 'filling', source: 'lead', sourceId: lead.id, copies: 1, targetStationId: front.id },
        sender.actor,
        LAN,
      );
      expect(job.targetStation).toEqual({ id: front.id, name: 'Front desk' });

      expect(await print.claimJob(job.id, two.actor, SECOND)).toBeNull();
      expect(await print.claimJob(job.id, one.actor, FIRST)).toMatchObject({ status: 'printing' });
    });

    it('needs a registered station, a station key and print.station to claim', async () => {
      const { job } = await queued();
      const one = await person('one', STATION);
      const sender = await person('bina', SENDER);

      await expect(print.claimJob(job.id, one.actor, FIRST)).rejects.toMatchObject({ messageKey: 'validation.print.stationUnknown' });
      await register(FIRST, 'Front desk', one.actor);
      await expect(print.claimJob(job.id, one.actor, LAN)).rejects.toMatchObject({ messageKey: 'validation.print.stationNeedsDesktop' });
      await expect(print.claimJob(job.id, sender.actor, FIRST)).rejects.toMatchObject({ permission: 'print.station' });
    });

    it('registers a station only from a connection that has a key, and shows it online for 90 seconds', async () => {
      const one = await person('one', STATION);
      await expect(
        print.saveStation({ printerName: 'HP', autoPrint: true }, one.actor, LAN),
      ).rejects.toMatchObject({ messageKey: 'validation.print.stationNeedsDesktop' });
      await expect(print.saveStation({ printerName: 'HP' }, one.actor, FIRST)).rejects.toThrow(ValidationError);

      const station = await print.saveStation({ printerName: 'HP', autoPrint: true }, one.actor, FIRST);
      expect(station).toMatchObject({ printerName: 'HP', autoPrint: true, online: true, isSelf: true });
      // No such panel is on file here, so it takes the fallback name.
      expect(station.name).toBe('Office PC');

      await db()('print_stations').update({ last_seen_at: db().raw("now() - interval '91 seconds'") });
      expect((await print.listStations(one.actor, SECOND))[0]).toMatchObject({ online: false, isSelf: false });

      // The Master PC names itself.
      const master = await print.saveStation({ printerName: null, autoPrint: false }, one.actor, MASTER_PC);
      expect(master.name).toBe('Master PC');
    });
  });

  describe('marking and cancelling', () => {
    async function queued(copies = 1, existing?: Person) {
      const { lead } = await seedLead();
      const sender = existing ?? (await person('asha', SENDER));
      const job = await print.sendJob({ requestId: requestId(), kind: 'filling', source: 'lead', sourceId: lead.id, copies }, sender.actor, LAN);
      return { sender, job };
    }

    it('marks a job printed, then not printed, clearing everything the print set; auditing both', async () => {
      const { job } = await queued();
      const desk = await person('desk', STATION);
      await register(FIRST, 'Front desk', desk.actor);

      const printed = await print.markJob({ id: job.id, printed: true, printerName: 'HP LaserJet' }, desk.actor, FIRST);
      expect(printed).toMatchObject({ status: 'printed', printerName: 'HP LaserJet', printedBy: { id: desk.id }, printedStationName: 'Front desk' });
      // A double click is harmless.
      expect((await print.markJob({ id: job.id, printed: true }, desk.actor, FIRST)).status).toBe('printed');

      const back = await print.markJob({ id: job.id, printed: false }, desk.actor, FIRST);
      expect(back).toMatchObject({ status: 'queued', printedBy: null, printedAt: null, printerName: null, printedStationName: null });
      expect(await activityActions()).toEqual(['sent', 'printed', 'unprinted']);

      const audit = await db()('activity_log').where({ entity_type: 'print_job', action: 'printed' }).first('details');
      expect(audit.details).toMatchObject({ kind: 'filling' });
      expect(Object.keys(audit.details).sort()).toEqual(['kind', 'number']);
    });

    it('needs print.station to mark, and cancelled is final', async () => {
      const { job, sender } = await queued();
      const desk = await person('desk', STATION);
      await expect(print.markJob({ id: job.id, printed: true }, sender.actor, LAN)).rejects.toMatchObject({ permission: 'print.station' });

      await print.cancelJob(job.id, desk.actor);
      await expect(print.markJob({ id: job.id, printed: true }, desk.actor, LAN)).rejects.toMatchObject({
        messageKey: 'validation.print.notPrintable',
      });
      await expect(print.markJob({ id: job.id, printed: false }, desk.actor, LAN)).rejects.toThrow(ValidationError);
    });

    it('lets a sender cancel only their own queued job, and a station holder any queued one', async () => {
      const { job, sender } = await queued();
      const other = await person('bina', SENDER);
      const desk = await person('desk', STATION);

      // Not theirs, so it does not exist for them.
      await expect(print.cancelJob(job.id, other.actor)).rejects.toThrow(NotFoundError);
      const cancelled = await print.cancelJob(job.id, sender.actor);
      expect(cancelled).toMatchObject({ status: 'cancelled', cancelledBy: { id: sender.id } });
      // Again is a no-op, not an error.
      expect((await print.cancelJob(job.id, sender.actor)).status).toBe('cancelled');

      const second = await queued(1, sender);
      expect((await print.cancelJob(second.job.id, desk.actor)).status).toBe('cancelled');
      expect(await activityActions()).toEqual(['sent', 'cancelled', 'sent', 'cancelled']);
    });

    it('refuses to cancel a job that is being printed or is printed', async () => {
      const { job, sender } = await queued();
      const desk = await person('desk', STATION);
      await register(FIRST, 'Front desk', desk.actor);
      await print.claimJob(job.id, desk.actor, FIRST);
      await expect(print.cancelJob(job.id, sender.actor)).rejects.toMatchObject({ messageKey: 'validation.print.notQueued' });

      await print.markJob({ id: job.id, printed: true }, desk.actor, FIRST);
      await expect(print.cancelJob(job.id, sender.actor)).rejects.toMatchObject({ messageKey: 'validation.print.notQueued' });
    });

    it('lets the claimant give its own claim back after a failed print, and nobody else', async () => {
      const { job } = await queued();
      const one = await person('one', STATION);
      const two = await person('two', STATION);
      await register(FIRST, 'Front desk', one.actor);
      await register(SECOND, 'Back office', two.actor);
      await print.claimJob(job.id, one.actor, FIRST);

      expect((await print.markJob({ id: job.id, printed: false }, two.actor, SECOND)).status).toBe('printing');
      expect((await print.markJob({ id: job.id, printed: false }, one.actor, FIRST)).status).toBe('queued');
      // Giving a claim back is not audited: only sent, printed, unprinted and cancelled are.
      expect(await activityActions()).toEqual(['sent']);
    });

    it('prints a job from a queued state without a claim, as a person at the printer does', async () => {
      const { job } = await queued();
      const desk = await person('desk', STATION);
      expect((await print.markJob({ id: job.id, printed: true, printerName: 'Office laser' }, desk.actor, LAN)).printerName).toBe('Office laser');
    });
  });

  describe('the sender\'s bell and the live push', () => {
    it('tells the sender once when somebody else prints, not when they print their own', async () => {
      const { lead } = await seedLead();
      const sender = await person('asha', [...SENDER, ...STATION]);
      const desk = await person('desk', STATION);
      const mine = await print.sendJob({ requestId: requestId(), kind: 'filling', source: 'lead', sourceId: lead.id, copies: 1 }, sender.actor, LAN);
      const theirs = await print.sendJob({ requestId: requestId(), kind: 'filling', source: 'lead', sourceId: lead.id, copies: 1 }, sender.actor, LAN);

      await print.markJob({ id: mine.id, printed: true }, sender.actor, LAN);
      await print.markJob({ id: theirs.id, printed: true }, desk.actor, LAN);
      await new Promise((resolve) => setTimeout(resolve, 100));

      const notices = await db()('user_notifications').where({ user_id: sender.id }).select('kind', 'params', 'link');
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({
        kind: 'print.printed',
        params: { name: 'desk', party: 'Shree Ceramics' },
        link: { kind: 'print', id: theirs.id },
      });
    });

    it('publishes the tenant and a summary with no sheet in it, for a send and each change', async () => {
      const { lead } = await seedLead();
      const sender = await person('asha', SENDER);
      const desk = await person('desk', STATION);
      const job = await print.sendJob({ requestId: requestId(), kind: 'filling', source: 'lead', sourceId: lead.id, copies: 1 }, sender.actor, LAN);
      await print.markJob({ id: job.id, printed: true }, desk.actor, LAN);
      await print.markJob({ id: job.id, printed: false }, desk.actor, LAN);
      await print.cancelJob(job.id, desk.actor);

      expect(events.map((event) => event.job.status)).toEqual(['queued', 'printed', 'queued', 'cancelled']);
      for (const event of events) {
        expect(event.tenantId).toBe(tenantId);
        expect(event.job).not.toHaveProperty('document');
        expect(event.job.sender?.id).toBe(sender.id);
      }
    });

    it('publishes the jobs a closed connection held, back as queued', async () => {
      const { lead } = await seedLead();
      const sender = await person('asha', SENDER);
      const one = await person('one', STATION);
      await register(FIRST, 'Front desk', one.actor);
      const job = await print.sendJob({ requestId: requestId(), kind: 'filling', source: 'lead', sourceId: lead.id, copies: 1 }, sender.actor, LAN);
      await print.claimJob(job.id, one.actor, FIRST);
      events.length = 0;

      await print.releaseClaimsOf('socket-one');
      expect(events.map((event) => [event.job.id, event.job.status])).toEqual([[job.id, 'queued']]);
    });
  });

  describe('keeping the sheet for 30 days', () => {
    it('drops the frozen note of old printed and cancelled jobs on the next send, and only those', async () => {
      const { lead } = await seedLead();
      const sender = await person('asha', SENDER);
      const desk = await person('desk', STATION);
      const send = () => print.sendJob({ requestId: requestId(), kind: 'filling', source: 'lead', sourceId: lead.id, copies: 1 }, sender.actor, LAN);
      const oldPrinted = await send();
      const oldCancelled = await send();
      const oldQueued = await send();
      const recentPrinted = await send();
      await print.markJob({ id: oldPrinted.id, printed: true }, desk.actor, LAN);
      await print.markJob({ id: recentPrinted.id, printed: true }, desk.actor, LAN);
      await print.cancelJob(oldCancelled.id, desk.actor);
      await db()('print_jobs')
        .whereIn('id', [oldPrinted.id, oldCancelled.id, oldQueued.id])
        .update({ updated_at: db().raw("now() - interval '31 days'") });

      await send();

      const payloads = await db()('print_jobs').select('id', db().raw('(payload IS NOT NULL) as has'));
      const has = Object.fromEntries(payloads.map((row: { id: string; has: boolean }) => [row.id, row.has]));
      expect(has[oldPrinted.id]).toBe(false);
      expect(has[oldCancelled.id]).toBe(false);
      expect(has[oldQueued.id]).toBe(true);
      expect(has[recentPrinted.id]).toBe(true);

      // The row, who sent and printed it, and when, stay; the job reads as having no sheet.
      const stripped = await print.getJob(oldPrinted.id, desk.actor);
      expect(stripped).toMatchObject({ document: null, hasDocument: false, status: 'printed', sender: { id: sender.id } });
    });

    it('will not hand a job with no sheet to a station', async () => {
      const { lead } = await seedLead();
      const sender = await person('asha', SENDER);
      const one = await person('one', STATION);
      await register(FIRST, 'Front desk', one.actor);
      const job = await print.sendJob({ requestId: requestId(), kind: 'filling', source: 'lead', sourceId: lead.id, copies: 1 }, sender.actor, LAN);
      await db()('print_jobs').where({ id: job.id }).update({ payload: null });
      expect(await print.claimJob(job.id, one.actor, FIRST)).toBeNull();
    });
  });

  describe('REST', () => {
    it('guards the routes with a session and the right key, and sends, lists, marks and cancels over HTTP', async () => {
      const app = createApp();
      const { lead } = await seedLead();
      await person('nobody', ['leads.view']);
      await person('asha', SENDER);
      await person('desk', STATION);

      await request(app).get('/api/print-jobs').expect(401);

      const denied = request.agent(app);
      await denied.post('/api/auth/sign-in').send({ username: 'nobody', password: PASSWORD }).expect(200);
      await denied.get('/api/print-jobs').expect(403);
      expect((await denied.post('/api/print-jobs').send({}).expect(403)).body.details).toMatchObject({ permission: 'print.send' });

      const asha = request.agent(app);
      await asha.post('/api/auth/sign-in').send({ username: 'asha', password: PASSWORD }).expect(200);
      // From a browser on another PC (its Host is not the Master PC's) the send is marked as coming from the LAN.
      const sent = await asha
        .post('/api/print-jobs')
        .set('Host', '192.168.1.50:3000')
        .send({ requestId: requestId(), kind: 'filling', source: 'lead', sourceId: lead.id, copies: 2 })
        .expect(201);
      expect(sent.body).toMatchObject({ status: 'queued', copies: 2, requestedFrom: 'lan' });
      // A plain sender cannot mark, and cannot register a station.
      expect((await asha.post(`/api/print-jobs/${sent.body.id}/printed`).send({ printed: true }).expect(403)).body.details).toMatchObject({
        permission: 'print.station',
      });
      await asha.put('/api/print-stations/self').send({ printerName: null, autoPrint: false }).expect(403);

      const listed = await asha.get('/api/print-jobs').query({ status: 'waiting' }).expect(200);
      expect(listed.body.jobs.map((job: PrintJobSummary) => job.id)).toEqual([sent.body.id]);

      const desk = request.agent(app);
      await desk.post('/api/auth/sign-in').send({ username: 'desk', password: PASSWORD }).expect(200);
      const marked = await desk.post(`/api/print-jobs/${sent.body.id}/printed`).send({ printed: true, printerName: 'HP' }).expect(200);
      expect(marked.body).toMatchObject({ status: 'printed', printerName: 'HP' });
      // A browser on another PC has no station to be; the Master PC's own window does.
      const refused = await desk
        .put('/api/print-stations/self')
        .set('Host', '192.168.1.50:3000')
        .send({ printerName: 'HP', autoPrint: true })
        .expect(403);
      expect(refused.body.messageKey).toBe('validation.print.stationNeedsDesktop');
      const station = await desk.put('/api/print-stations/self').send({ printerName: 'HP', autoPrint: true }).expect(200);
      expect(station.body).toMatchObject({ name: 'Master PC', printerName: 'HP', autoPrint: true, online: true, isSelf: true });

      const cancelled = await asha.post(`/api/print-jobs/${sent.body.id}/cancel`).expect(400);
      expect(cancelled.body.messageKey).toBe('validation.print.notQueued');
    });
  });

  describe('the migration\'s grant', () => {
    it('hands admin roles print.send and print.station once, and leaves office and management roles alone', async () => {
      const officeRole = await roleService.createRole({ name: 'Plain office', tier: 'office', permissions: ['leads.view'] }, admin);
      const managerRole = await roleService.createRole({ name: 'Plain manager', tier: 'management', permissions: ['leads.view'] }, admin);
      const adminRole = await roleService.createRole({ name: 'Plain admin', tier: 'admin', permissions: ['leads.view'] }, admin);

      await printroomMigration.up(db());
      await printroomMigration.up(db());

      const stored = async (id: string): Promise<string[]> =>
        ((await db()('roles').where({ id }).first('permissions')).permissions as string[]).filter((key) => key.startsWith('print.'));
      expect(await stored(officeRole.id)).toEqual([]);
      expect(await stored(managerRole.id)).toEqual([]);
      expect(await stored(adminRole.id)).toEqual(['print.send', 'print.station']);
    });
  });
});
