/**
 * Applying an Office Panel's offline outbox
 * (docs/LEAD_GENERATION_FLOW.md §4.5, §7).
 *
 * These are the behaviours that only appear under conditions nobody can produce
 * by clicking: two panels editing while disconnected, a batch that arrives
 * twice, and panels reconnecting in the "wrong" order. Every one of them is
 * silent when it goes wrong — a lost edit looks exactly like a screen that
 * failed to refresh — so they are pinned here rather than left to a browser.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Mutation } from '@orderbook/shared';
import { formatTemporaryId, initialHlcState, tickHlc } from '@orderbook/shared';

import { canRunIntegrationTests } from './helpers/db.js';
import {
  ALL_PERMISSIONS,
  actorWith,
  resetData,
  setupDatabase,
  stageIdByName,
  teardownDatabase,
  testActor,
} from './helpers/fixtures.js';
import { db } from '../src/db/knex.js';
import type { ActorContext } from '../src/domain/actor.js';
import * as catalog from '../src/services/catalog.service.js';
import * as chat from '../src/services/chat.service.js';
import * as conflicts from '../src/services/conflict.service.js';
import * as leads from '../src/services/lead.service.js';
import * as partyAccess from '../src/services/party-access.service.js';
import * as roleService from '../src/services/role.service.js';
import * as userService from '../src/services/user.service.js';
import * as orders from '../src/services/order.service.js';
import * as sync from '../src/services/sync.service.js';
import { onConflict } from '../src/services/change-bus.js';

const PANEL_A = 'A3F9K2';
const PANEL_B = 'B7QMX4';

let actor: ActorContext;

/**
 * Stamps an HLC for a device, `offsetMs` after "now".
 *
 * Relative to the real clock on purpose: an HLC carries wall time, and the
 * Master stamps records as it creates them. A fixed past timestamp would make
 * every panel edit look older than the record it is editing, and the merge
 * would correctly — and unhelpfully — refuse all of them.
 */
function hlcFor(deviceCode: string, offsetMs: number): string {
  return tickHlc(initialHlcState(deviceCode), Date.now() + offsetMs).hlc;
}

function mutation(overrides: Partial<Mutation> & Pick<Mutation, 'kind' | 'entity'>): Mutation {
  return {
    mutationId: `m-${Math.random().toString(36).slice(2)}`,
    entityId: formatTemporaryId(PANEL_A, 1),
    hlc: hlcFor(PANEL_A, 1_000),
    deviceCode: PANEL_A,
    payload: {},
    fields: [],
    baseFieldHlc: {},
    actorUserId: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe.skipIf(!canRunIntegrationTests)('offline sync (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    actor = await testActor({ deviceCode: PANEL_A, actorType: 'office_panel' });
  });

  async function seed() {
    const party = await catalog.createParty({ name: 'Offline Traders' }, actor);
    const product = await catalog.createProduct(
      { categoryName: 'Tiles', variants: [{ code: 'OFF-01' }], name: 'Matte Tile' },
      actor,
    );
    return { party, product };
  }

  describe('creating while offline', () => {
    it('promotes a temporary id and keeps the old one resolvable forever', async () => {
      const { party, product } = await seed();
      const temporaryId = formatTemporaryId(PANEL_A, 7);

      const response = await sync.applyPush(
        {
          mutations: [
            mutation({
              kind: 'lead.create',
              entity: 'lead',
              entityId: temporaryId,
              payload: {
                partyId: party.id,
                items: [
                  {
                    productId: product.id,
                    variantId: product.variants[0]!.id,
                    quantity: 3,
                    packaging: 'carton',
                  },
                ],
              },
            }),
          ],
        },
        actor,
      );

      const result = response.results[0];
      expect(result?.status).toBe('applied');
      expect(result?.entityId).toBe('LD0000000001');

      // The docket printed offline still finds the lead after renumbering.
      expect(response.idMappings).toEqual([
        expect.objectContaining({ temporaryId, permanentId: 'LD0000000001' }),
      ]);

      const mapped = await db()('id_map').where({ temporary_id: temporaryId }).first();
      expect(mapped?.permanent_id).toBe('LD0000000001');
    });

    it('resolves a temporary party id inside a lead payload, in the same batch', async () => {
      // The flow this is about: a salesperson opens Add Lead, uses the inline
      // party drawer to add the customer standing at the counter, picks
      // products and saves. Both writes queue behind one another in the outbox
      // and arrive in one batch.
      //
      // `route()` used to resolve `mutation.entityId` and nothing else, so
      // `payload.partyId` reached `createLead` as the 15-character temporary id
      // the panel minted. `lead.service.ts` does an exact-match party lookup
      // with no `id_map` fallback, threw `validation.lead.partyMissing`, and
      // `applyOne` recorded that as a **permanent** rejection — replaying it
      // returned the same refusal forever, and the panel settled it out of the
      // outbox along with the optimistic overlay. The lead vanished with no
      // trace and nothing ever told the person who typed it.
      //
      // Every other `lead.create` test in this file uses a permanent party id,
      // which is why nothing caught it.
      const product = await catalog.createProduct(
        { name: 'Gloss Basin', categoryName: 'Basins', variants: [{ code: 'OFF-02' }] },
        actor,
      );

      const temporaryPartyId = formatTemporaryId(PANEL_A, 21);
      const temporaryLeadId = formatTemporaryId(PANEL_A, 22);

      const response = await sync.applyPush(
        {
          mutations: [
            mutation({
              kind: 'party.create',
              entity: 'party',
              entityId: temporaryPartyId,
              payload: { name: 'Counter Customer' },
            }),
            mutation({
              kind: 'lead.create',
              entity: 'lead',
              entityId: temporaryLeadId,
              hlc: hlcFor(PANEL_A, 2_000),
              payload: {
                partyId: temporaryPartyId,
                items: [
                  {
                    productId: product.id,
                    variantId: product.variants[0]!.id,
                    packaging: 'carton',
                    quantity: 2,
                  },
                ],
              },
            }),
          ],
        },
        actor,
      );

      expect(response.results.map((result) => result.status)).toEqual(['applied', 'applied']);

      const partyId = response.results[0]?.entityId;
      const leadId = response.results[1]?.entityId;
      expect(partyId).toBeTruthy();

      const lead = await db()('leads').where({ id: leadId }).first();
      // The lead points at the party's *permanent* id, not the one the panel
      // minted — which is what makes it survive the round trip.
      expect(lead?.party_id).toBe(partyId);
    });

    it('applies a replayed batch once, not twice', async () => {
      const { party, product } = await seed();
      const only = mutation({
        kind: 'lead.create',
        entity: 'lead',
        entityId: formatTemporaryId(PANEL_A, 11),
        payload: {
          partyId: party.id,
          items: [
            {
              productId: product.id,
              variantId: product.variants[0]!.id,
              quantity: 1,
              packaging: 'carton',
            },
          ],
        },
      });

      const first = await sync.applyPush({ mutations: [only] }, actor);
      // The panel lost the acknowledgement and pushed the same batch again.
      const second = await sync.applyPush({ mutations: [only] }, actor);

      expect(first.results[0]?.status).toBe('applied');
      expect(second.results[0]?.status).toBe('duplicate');
      expect(second.results[0]?.entityId).toBe(first.results[0]?.entityId);

      const rows = await db()('leads').select('id');
      expect(rows).toHaveLength(1);
    });

    it('recognises the same mutation id repeated inside one batch', async () => {
      const { party, product } = await seed();
      const only = mutation({
        kind: 'lead.create',
        entity: 'lead',
        payload: {
          partyId: party.id,
          items: [
            {
              productId: product.id,
              variantId: product.variants[0]!.id,
              quantity: 1,
              packaging: 'carton',
            },
          ],
        },
      });

      // The applied set was read once before the loop and never updated, so two
      // copies in one request both applied — two leads from one create — and the
      // second bookkeeping insert was swallowed by `onConflict().ignore()`,
      // leaving nothing to notice afterwards.
      const response = await sync.applyPush({ mutations: [only, { ...only }] }, actor);

      expect(response.results.map((result) => result.status)).toEqual(['applied', 'duplicate']);

      const rows = await db()('leads').select('id');
      expect(rows).toHaveLength(1);
    });

    it('numbers a batch by (hlc, device), not by arrival order', async () => {
      const { party, product } = await seed();

      const item = {
        productId: product.id,
        variantId: product.variants[0]!.id,
        quantity: 1,
        packaging: 'carton',
      };

      // Panel B's lead was raised first in real time; panel A's reached the
      // Master first. The earlier HLC must still win the lower number.
      const fromB = mutation({
        kind: 'lead.create',
        entity: 'lead',
        entityId: formatTemporaryId(PANEL_B, 1),
        deviceCode: PANEL_B,
        hlc: hlcFor(PANEL_B, 1_000),
        payload: { partyId: party.id, items: [item] },
      });
      const fromA = mutation({
        kind: 'lead.create',
        entity: 'lead',
        entityId: formatTemporaryId(PANEL_A, 1),
        deviceCode: PANEL_A,
        hlc: hlcFor(PANEL_A, 61_000),
        payload: { partyId: party.id, items: [item] },
      });

      const response = await sync.applyPush({ mutations: [fromA, fromB] }, actor);

      const byMutation = new Map(
        response.results.map((result) => [result.mutationId, result.entityId]),
      );
      expect(byMutation.get(fromB.mutationId)).toBe('LD0000000001');
      expect(byMutation.get(fromA.mutationId)).toBe('LD0000000002');
    });
  });

  describe('merging concurrent edits', () => {
    async function existingLead() {
      const { party, product } = await seed();
      return leads.createLead(
        {
          partyId: party.id,
          notes: 'original note',
          items: [
            {
              productId: product.id,
              variantId: product.variants[0]!.id,
              quantity: 2,
              packaging: 'carton',
            },
          ],
        },
        actor,
      );
    }

    it('keeps both edits when two panels touch different fields', async () => {
      const lead = await existingLead();

      const response = await sync.applyPush(
        {
          mutations: [
            mutation({
              kind: 'lead.update',
              entity: 'lead',
              entityId: lead.id,
              deviceCode: PANEL_A,
              hlc: hlcFor(PANEL_A, 100_000),
              fields: ['notes'],
              // A had pulled the lead, so it names the clock it replaced.
              baseFieldHlc: { notes: lead.sync.fieldHlc.notes! },
              payload: { notes: 'A called them back' },
            }),
            mutation({
              kind: 'lead.update',
              entity: 'lead',
              entityId: lead.id,
              deviceCode: PANEL_B,
              hlc: hlcFor(PANEL_B, 200_000),
              fields: ['followUpDate'],
              payload: { followUpDate: '2026-09-01' },
            }),
          ],
        },
        actor,
      );

      expect(response.results.every((result) => result.status === 'applied')).toBe(true);

      const after = await leads.getLead(lead.id, actor);
      expect(after.notes).toBe('A called them back');
      expect(after.followUpDate).toBe('2026-09-01');
    });

    it('gives a contested field to the higher HLC and records the loser', async () => {
      const lead = await existingLead();

      const response = await sync.applyPush(
        {
          mutations: [
            mutation({
              kind: 'lead.update',
              entity: 'lead',
              entityId: lead.id,
              deviceCode: PANEL_A,
              hlc: hlcFor(PANEL_A, 100_000),
              fields: ['notes'],
              // A had seen the note it is replacing — an ordinary edit.
              baseFieldHlc: { notes: lead.sync.fieldHlc.notes! },
              payload: { notes: 'A wrote this' },
            }),
            mutation({
              kind: 'lead.update',
              entity: 'lead',
              entityId: lead.id,
              deviceCode: PANEL_B,
              hlc: hlcFor(PANEL_B, 200_000),
              fields: ['notes'],
              // B has been offline since before A's edit, so it is writing over
              // something it never saw. That is the clash.
              baseFieldHlc: { notes: lead.sync.fieldHlc.notes! },
              payload: { notes: 'B wrote this' },
            }),
          ],
        },
        actor,
      );

      const after = await leads.getLead(lead.id, actor);
      expect(after.notes).toBe('B wrote this');

      // B's push reported the merge, and A's value survives for review.
      expect(response.results.some((result) => result.status === 'merged')).toBe(true);

      const open = await conflicts.listConflicts(actor);
      expect(open).toHaveLength(1);
      expect(open[0]?.field).toBe('notes');
      expect(open[0]?.losingValue).toBe('A wrote this');
      expect(open[0]?.winningValue).toBe('B wrote this');
      expect(open[0]?.winningDeviceCode).toBe(PANEL_B);
    });

    it('does not report a conflict when the editor had seen the value', async () => {
      const lead = await existingLead();

      await sync.applyPush(
        {
          mutations: [
            mutation({
              kind: 'lead.update',
              entity: 'lead',
              entityId: lead.id,
              deviceCode: PANEL_B,
              hlc: hlcFor(PANEL_B, 200_000),
              fields: ['notes'],
              // The panel names the clock it believed was current — the normal
              // "I pulled, then edited" case.
              baseFieldHlc: { notes: (await leads.getLead(lead.id, actor)).sync.fieldHlc.notes! },
              payload: { notes: 'B revised it' },
            }),
          ],
        },
        actor,
      );

      expect((await leads.getLead(lead.id, actor)).notes).toBe('B revised it');
      expect(await conflicts.listConflicts(actor)).toHaveLength(0);
    });

    it('can put the losing value back', async () => {
      const lead = await existingLead();

      await sync.applyPush(
        {
          mutations: [
            mutation({
              kind: 'lead.update',
              entity: 'lead',
              entityId: lead.id,
              deviceCode: PANEL_B,
              hlc: hlcFor(PANEL_B, 200_000),
              fields: ['notes'],
              // A stale, non-empty base: B had seen an older note than the one
              // stored. (An empty base now means "unknown", and a newer edit
              // with no base wins silently — see the next describe.)
              baseFieldHlc: { notes: hlcFor(PANEL_A, -60_000) },
              payload: { notes: 'B overwrote it' },
            }),
          ],
        },
        actor,
      );

      const [conflict] = await conflicts.listConflicts(actor);
      await conflicts.resolveConflict(
        { conflictId: conflict!.id, action: 'restoreLoser' },
        actor,
      );

      expect((await leads.getLead(lead.id, actor)).notes).toBe('original note');
      expect(await conflicts.listConflicts(actor)).toHaveLength(0);
    });
  });

  describe('an Office edit that names no base clock', () => {
    const noteEdit = (leadId: string, offsetMs: number, notes: string) =>
      mutation({
        kind: 'lead.update',
        entity: 'lead',
        entityId: leadId,
        deviceCode: PANEL_B,
        hlc: hlcFor(PANEL_B, offsetMs),
        fields: ['notes'],
        // The Office outbox stores `{}` for every lead and order edit.
        baseFieldHlc: {},
        payload: { notes },
      });

    async function aLead() {
      const { party, product } = await seed();
      return leads.createLead(
        {
          partyId: party.id,
          notes: 'original note',
          items: [{ productId: product.id, variantId: product.variants[0]!.id, quantity: 1, packaging: 'carton' }],
        },
        actor,
      );
    }

    it('applies a newer edit without recording a spurious conflict (C7)', async () => {
      const lead = await aLead();

      const { results } = await sync.applyPush({ mutations: [noteEdit(lead.id, 200_000, 'newer')] }, actor);

      expect(results[0]?.status).toBe('applied');
      expect((await leads.getLead(lead.id, actor)).notes).toBe('newer');
      expect(await conflicts.listConflicts(actor)).toHaveLength(0);
    });

    it('still records an older edit as the loser (C7)', async () => {
      const lead = await aLead();
      await leads.updateLead(lead.id, { notes: 'master wrote this' }, actor);

      const { results } = await sync.applyPush({ mutations: [noteEdit(lead.id, -60_000, 'stale')] }, actor);

      expect(results[0]?.status).toBe('merged');
      expect((await leads.getLead(lead.id, actor)).notes).toBe('master wrote this');
      expect(await conflicts.listConflicts(actor)).toHaveLength(1);
    });
  });

  describe('a push carrying a signed-in person work under the panel own role (C8)', () => {
    const edit = (leadId: string, actorUserId: string | null) =>
      mutation({
        kind: 'lead.update',
        entity: 'lead',
        entityId: leadId,
        fields: ['notes'],
        payload: { notes: 'queued by a person' },
        actorUserId,
      });

    async function aLead() {
      const { party, product } = await seed();
      return leads.createLead(
        {
          partyId: party.id,
          items: [{ productId: product.id, variantId: product.variants[0]!.id, quantity: 1, packaging: 'carton' }],
        },
        actor,
      );
    }

    const recorded = async (mutationId: string) =>
      db()('applied_mutations').where({ mutation_id: mutationId }).first();

    it('is retried with a 503 when the panel role could not do it, and records nothing', async () => {
      const lead = await aLead();
      const panel = await actorWith(['leads.view']);
      const m = edit(lead.id, 'some-user-id');

      await expect(
        sync.applyPush({ mutations: [m] }, { ...panel, actorType: 'office_panel' }),
      ).rejects.toMatchObject({ statusCode: 503, messageKey: 'error.unavailable.signInToSync' });

      expect(await recorded(m.mutationId)).toBeUndefined();
    });

    it('still applies under the panel role when the panel role may do it', async () => {
      const lead = await aLead();
      const m = edit(lead.id, 'some-user-id');

      const { results } = await sync.applyPush({ mutations: [m] }, { ...actor, actorType: 'office_panel' });

      expect(results[0]?.status).toBe('applied');
    });

    it('applies under a user actor with the permission', async () => {
      const lead = await aLead();
      const user = { ...(await actorWith(['leads.view', 'leads.edit'])), actorType: 'user' as const };

      const { results } = await sync.applyPush({ mutations: [edit(lead.id, 'some-user-id')] }, user);

      expect(results[0]?.status).toBe('applied');
    });
  });

  describe('what an Office edit now carries, and what a merge refuses', () => {
    /** A lead with one line, the way an Office edit would find it, plus a second product to swap in. */
    async function leadWithLine() {
      const { party, product } = await seed();
      const variant = product.variants[0]!;
      const other = await catalog.createProduct(
        { categoryName: 'Tiles', variants: [{ code: 'OFF-09' }], name: 'Gloss Tile' },
        actor,
      );
      const line = { productId: product.id, variantId: variant.id, quantity: 2, packaging: 'carton' };
      const lead = await leads.createLead({ partyId: party.id, notes: 'original note', items: [line] }, actor);
      const otherLine = { productId: other.id, variantId: other.variants[0]!.id, quantity: 4, packaging: 'carton' };
      return { party, product, lead, line, otherLine };
    }

    const push = (...mutations: Mutation[]) => sync.applyPush({ mutations }, actor);

    const leadEdit = (leadId: string, overrides: Partial<Mutation>) =>
      mutation({ kind: 'lead.update', entity: 'lead', entityId: leadId, ...overrides });

    describe('lead lines (items)', () => {
      it('an Office-shaped edit replaces the line set, with no conflict', async () => {
        const { lead, line, otherLine } = await leadWithLine();

        const response = await push(
          leadEdit(lead.id, {
            fields: ['items'],
            // The Office stores `{}` for every edit it queues.
            baseFieldHlc: {},
            payload: { items: [{ ...line, quantity: 7 }, otherLine] },
          }),
        );

        expect(response.results[0]?.status).toBe('applied');
        expect(response.results[0]?.conflicts).toEqual([]);
        const after = await leads.getLead(lead.id, actor);
        expect(after.items.map((item) => item.quantity)).toEqual([7, 4]);
        expect(after.sync.fieldHlc.items).not.toBe(lead.sync.fieldHlc.items);
        expect(await conflicts.listConflicts(actor)).toHaveLength(0);
      });

      it('identical lines plus a notes change rewrite neither the lines nor their clock', async () => {
        const { lead, line } = await leadWithLine();

        const response = await push(
          leadEdit(lead.id, {
            fields: ['items', 'notes'],
            // Names the note's clock, as a panel that had pulled the lead would.
            baseFieldHlc: { notes: lead.sync.fieldHlc.notes! },
            payload: { items: [line], notes: 'only the note moved' },
          }),
        );

        expect(response.results[0]?.status).toBe('applied');
        const after = await leads.getLead(lead.id, actor);
        expect(after.notes).toBe('only the note moved');
        expect(after.items.map((item) => item.id)).toEqual(lead.items.map((item) => item.id));
        expect(after.sync.fieldHlc.items).toBe(lead.sync.fieldHlc.items);
      });

      it('refuses a converted lead, readably', async () => {
        const { lead, line } = await leadWithLine();
        await orders.convertLead({ leadId: lead.id }, actor);

        const response = await push(
          leadEdit(lead.id, { fields: ['items'], payload: { items: [{ ...line, quantity: 9 }] } }),
        );

        expect(response.results[0]?.status).toBe('rejected');
        expect(response.results[0]?.error).toMatch(/become a final order/i);
        expect((await leads.getLead(lead.id, actor)).items[0]?.quantity).toBe(2);
      });

      it('refuses an unknown variant and applies none of the same edit', async () => {
        const { lead, line } = await leadWithLine();

        const response = await push(
          leadEdit(lead.id, {
            fields: ['items', 'notes'],
            payload: { items: [{ ...line, variantId: 'gone' }], notes: 'should not land' },
          }),
        );

        expect(response.results[0]?.status).toBe('rejected');
        expect(response.results[0]?.error).toMatch(/variants? no longer exists/i);
        expect((await leads.getLead(lead.id, actor)).notes).toBe('original note');
      });

      it('an older edit loses, is recorded once, and can be put back', async () => {
        const { lead, line } = await leadWithLine();
        // The Master's own edit lands first and stamps `items`.
        const online = await leads.updateLead(lead.id, { items: [{ ...line, quantity: 5 }] }, actor);
        expect(online.sync.fieldHlc.items).not.toBe(lead.sync.fieldHlc.items);

        const response = await push(
          leadEdit(lead.id, {
            fields: ['items'],
            hlc: hlcFor(PANEL_A, -1_000_000_000),
            payload: { items: [{ ...line, quantity: 9 }] },
          }),
        );

        expect(response.results[0]?.status).toBe('merged');
        expect(response.results[0]?.conflicts.map((conflict) => conflict.field)).toEqual(['items']);
        expect((await leads.getLead(lead.id, actor)).items[0]?.quantity).toBe(5);

        const [conflict] = await conflicts.listConflicts(actor);
        await conflicts.resolveConflict({ conflictId: conflict!.id, action: 'restoreLoser' }, actor);

        const restored = await leads.getLead(lead.id, actor);
        expect(restored.items[0]?.quantity).toBe(9);
        expect(restored.sync.fieldHlc.items).not.toBe(online.sync.fieldHlc.items);
      });

      it.each([['x'], [[{}]], [[]]])('refuses malformed items %j with a sentence', async (items) => {
        const { lead } = await leadWithLine();

        const response = await push(leadEdit(lead.id, { fields: ['items'], payload: { items } }));

        expect(response.results[0]?.status).toBe('rejected');
        expect(response.results[0]?.error).toMatch(/at least one product|no longer exists/i);
        expect((await leads.getLead(lead.id, actor)).items).toHaveLength(1);
      });
    });

    describe('restoring a value', () => {
      it('keeps the other fields\' clocks, so a stale edit to them still loses', async () => {
        const { lead } = await leadWithLine();
        const online = await leads.updateLead(lead.id, { followUpDate: '2026-09-01' }, actor);
        const followUpClock = online.sync.fieldHlc.followUpDate;
        expect(followUpClock).toBeDefined();

        // A stale non-empty base: an empty one would now read as "unknown" and a
        // newer edit would win silently, leaving nothing to restore.
        await push(
          leadEdit(lead.id, {
            fields: ['notes'],
            baseFieldHlc: { notes: hlcFor(PANEL_A, -60_000) },
            payload: { notes: 'B overwrote it' },
          }),
        );
        const [conflict] = await conflicts.listConflicts(actor);
        await conflicts.resolveConflict({ conflictId: conflict!.id, action: 'restoreLoser' }, actor);

        const restored = await leads.getLead(lead.id, actor);
        expect(restored.notes).toBe('original note');
        expect(restored.sync.fieldHlc.followUpDate).toBe(followUpClock);

        // Replaying an older follow-up edit must still lose to the Master's.
        const stale = await push(
          leadEdit(lead.id, {
            fields: ['followUpDate'],
            hlc: hlcFor(PANEL_A, -1_000_000_000),
            payload: { followUpDate: '2026-01-01' },
          }),
        );
        expect(stale.results[0]?.conflicts.map((conflict) => conflict.field)).toEqual(['followUpDate']);
        expect((await leads.getLead(lead.id, actor)).followUpDate).toBe('2026-09-01');
      });
    });

    describe('restoring is no way around the merge checks', () => {
      /** A lead whose note lost a clash, so there is one open conflict to restore. */
      async function leadWithOpenConflict() {
        const { party, lead } = await leadWithLine();
        await push(
          leadEdit(lead.id, {
            fields: ['notes'],
            baseFieldHlc: { notes: hlcFor(PANEL_A, -60_000) },
            payload: { notes: 'B overwrote it' },
          }),
        );
        const [conflict] = await conflicts.listConflicts(actor);
        return { party, lead, conflict: conflict! };
      }

      it('refuses to restore a field of a lead that has since been converted', async () => {
        const { lead, conflict } = await leadWithOpenConflict();
        await orders.convertLead({ leadId: lead.id }, actor);

        await expect(
          conflicts.resolveConflict({ conflictId: conflict.id, action: 'restoreLoser' }, actor),
        ).rejects.toThrow(/final order|converted/i);
        expect((await leads.getLead(lead.id, actor)).notes).toBe('B overwrote it');
      });

      it('refuses a conflict on a party the caller is not assigned to', async () => {
        const { party, conflict } = await leadWithOpenConflict();
        const role = await roleService.createRole(
          { name: 'Desk mine', tier: 'office', permissions: ['leads.view'] },
          actor,
        );
        const { user } = await userService.createUser(
          { username: 'mine', displayName: 'mine', roleId: role.id },
          actor,
        );
        await partyAccess.replaceAssignments(
          party.id,
          { entries: [{ userId: user.id, level: 'manage' }], expectedVersion: party.sync.version },
          actor,
        );
        const outsider = {
          ...(await actorWith(['sync.resolveConflicts'])),
          actorId: 'someone-else',
          userId: 'someone-else',
        };

        await expect(
          conflicts.resolveConflict({ conflictId: conflict.id, action: 'restoreLoser' }, outsider),
        ).rejects.toThrow();
        expect(await conflicts.listConflicts(actor)).toHaveLength(1);
      });
    });

    describe('the same checks an online edit makes', () => {
      it('refuses a stage that does not exist, readably', async () => {
        const { lead } = await leadWithLine();
        const response = await push(
          leadEdit(lead.id, { fields: ['stageId'], payload: { stageId: 'no-such-stage' } }),
        );
        expect(response.results[0]?.status).toBe('rejected');
        expect(response.results[0]?.error).toMatch(/stage/i);
      });

      it('refuses an owner who is not a user, readably', async () => {
        const { lead } = await leadWithLine();
        const response = await push(
          leadEdit(lead.id, { fields: ['ownerId'], payload: { ownerId: 'nobody-here' } }),
        );
        expect(response.results[0]?.status).toBe('rejected');
        expect(response.results[0]?.error).toMatch(/owner/i);
      });

      async function dispatchedOrder() {
        const { lead } = await leadWithLine();
        const order = await orders.convertLead({ leadId: lead.id }, actor);
        return order;
      }

      const orderEdit = (orderId: string, overrides: Partial<Mutation>) =>
        mutation({ kind: 'order.update', entity: 'order', entityId: orderId, ...overrides });

      it('drops an owner change the actor may not make, and keeps the rest', async () => {
        const { lead } = await leadWithLine();
        const limited = await testActor({
          deviceCode: PANEL_A,
          actorType: 'office_panel',
          permissions: {
            ...ALL_PERMISSIONS,
            permissions: ALL_PERMISSIONS.permissions.filter((permission) => permission !== 'record.reassignOwner'),
          },
        });

        const response = await sync.applyPush(
          {
            mutations: [
              leadEdit(lead.id, {
                fields: ['ownerId', 'notes'],
                baseFieldHlc: { notes: lead.sync.fieldHlc.notes! },
                payload: { ownerId: 'somebody-else', notes: 'kept' },
              }),
            ],
          },
          limited,
        );

        expect(response.results[0]?.status).toBe('applied');
        const after = await leads.getLead(lead.id, actor);
        expect(after.ownerId).toBe(lead.ownerId);
        expect(after.notes).toBe('kept');
      });

      it('refuses a source that is not on the list', async () => {
        const { lead } = await leadWithLine();
        const response = await push(
          leadEdit(lead.id, { fields: ['sourcePlatform'], payload: { sourcePlatform: 'carrier-pigeon' } }),
        );
        expect(response.results[0]?.status).toBe('rejected');
        expect(response.results[0]?.error).toMatch(/not a configured pending order source/i);
      });

      it('refuses any edit of a converted lead', async () => {
        const { lead } = await leadWithLine();
        await orders.convertLead({ leadId: lead.id }, actor);
        const response = await push(leadEdit(lead.id, { fields: ['notes'], payload: { notes: 'too late' } }));
        expect(response.results[0]?.status).toBe('rejected');
        expect((await leads.getLead(lead.id, actor)).notes).toBe('original note');
      });

      it('refuses a move onto a party that does not exist', async () => {
        const { lead } = await leadWithLine();
        const response = await push(leadEdit(lead.id, { fields: ['partyId'], payload: { partyId: 'PT0000000099' } }));
        expect(response.results[0]?.status).toBe('rejected');
        expect(response.results[0]?.error).toMatch(/no longer exists/i);
      });

      it('refuses an edit of a dispatched order', async () => {
        const order = await dispatchedOrder();
        await orders.dispatchOrder({ orderId: order.id }, actor);

        const response = await push(orderEdit(order.id, { fields: ['notes'], payload: { notes: 'too late' } }));

        expect(response.results[0]?.status).toBe('rejected');
        expect(response.results[0]?.error).toMatch(/dispatched/i);
      });

      it('refuses a negative weight override', async () => {
        const order = await dispatchedOrder();
        const response = await push(
          orderEdit(order.id, { fields: ['totalWeightKgOverride'], payload: { totalWeightKgOverride: -3 } }),
        );
        expect(response.results[0]?.status).toBe('rejected');
        expect(response.results[0]?.error).toMatch(/cannot be negative/i);
      });

      it('normalises a vehicle number the way the online edit does', async () => {
        const order = await dispatchedOrder();
        const response = await push(
          orderEdit(order.id, { fields: ['vehicleNumber'], payload: { vehicleNumber: 'gj 01  ab 1234' } }),
        );
        expect(response.results[0]?.status).toBe('applied');
        expect((await orders.getOrder(order.id, actor)).vehicleNumber).toBe('GJ 01 AB 1234');
      });

      it('refuses a vehicle number with characters it cannot hold', async () => {
        const order = await dispatchedOrder();
        const response = await push(
          orderEdit(order.id, { fields: ['vehicleNumber'], payload: { vehicleNumber: 'GJ/01*AB' } }),
        );
        expect(response.results[0]?.status).toBe('rejected');
        expect(response.results[0]?.error).toMatch(/vehicle number/i);
      });

      it('refuses a blank party name', async () => {
        const { party } = await leadWithLine();
        const response = await push(
          mutation({ kind: 'party.update', entity: 'party', entityId: party.id, fields: ['name'], payload: { name: '   ' } }),
        );
        expect(response.results[0]?.status).toBe('rejected');
        expect(response.results[0]?.error).toMatch(/party name is required/i);
        expect((await catalog.getParty(party.id, actor)).name).toBe('Offline Traders');
      });
    });
  });

  describe('follow-ups queued behind a create', () => {
    it('resolves a stage change addressed by the temporary id', async () => {
      const { party, product } = await seed();
      const temporaryId = formatTemporaryId(PANEL_A, 21);

      const response = await sync.applyPush(
        {
          mutations: [
            mutation({
              kind: 'lead.create',
              entity: 'lead',
              entityId: temporaryId,
              hlc: hlcFor(PANEL_A, 1_000),
              payload: {
                partyId: party.id,
                items: [
                  {
                    productId: product.id,
                    variantId: product.variants[0]!.id,
                    quantity: 1,
                    packaging: 'carton',
                  },
                ],
              },
            }),
            // Raised on the same panel, minutes later, still offline — so it
            // names the lead by the only id that panel has ever known.
            mutation({
              kind: 'lead.setStage',
              entity: 'lead',
              entityId: temporaryId,
              hlc: hlcFor(PANEL_A, 300_000),
              payload: { stageId: await stageIdByName('lead', 'Quoted') },
            }),
          ],
        },
        actor,
      );

      expect(response.results.every((result) => result.status === 'applied')).toBe(true);
      expect((await leads.getLead('LD0000000001', actor)).stageName).toBe('Quoted');
    });

    it('resolves a lead raised on a party the panel created, by that party\'s temporary id', async () => {
      const { product } = await seed();
      const partyTemporaryId = formatTemporaryId(PANEL_A, 31);
      const leadTemporaryId = formatTemporaryId(PANEL_A, 32);

      // The party create is acknowledged first, on its own; the lead that
      // names the party by its temporary id arrives afterwards — the order the
      // New lead screen's "create a new party" produces.
      const first = await sync.applyPush(
        {
          mutations: [
            mutation({
              kind: 'party.create',
              entity: 'party',
              entityId: partyTemporaryId,
              payload: { name: 'Raised offline' },
            }),
          ],
        },
        actor,
      );
      expect(first.results[0]?.status).toBe('applied');

      const second = await sync.applyPush(
        {
          mutations: [
            mutation({
              kind: 'lead.create',
              entity: 'lead',
              entityId: leadTemporaryId,
              hlc: hlcFor(PANEL_A, 2_000),
              payload: {
                partyId: partyTemporaryId,
                items: [
                  {
                    productId: product.id,
                    variantId: product.variants[0]!.id,
                    quantity: 2,
                    packaging: 'carton',
                  },
                ],
              },
            }),
          ],
        },
        actor,
      );

      expect(second.results[0]?.status).toBe('applied');
      const lead = await leads.getLead(second.results[0]!.entityId, actor);
      expect(lead.partyName).toBe('Raised offline');
      expect(lead.partyId).toMatch(/^PT\d{10}$/);
    });
  });

  describe('stage moves are ordered by HLC (rule 6)', () => {
    async function aLead() {
      const { party, product } = await seed();
      return leads.createLead(
        {
          partyId: party.id,
          items: [{ productId: product.id, variantId: product.variants[0]!.id, quantity: 1, packaging: 'carton' }],
        },
        actor,
      );
    }

    const stageMove = (
      kind: 'lead.setStage' | 'order.setStage',
      entityId: string,
      stageId: string,
      offsetMs: number,
    ) =>
      mutation({
        kind,
        entity: kind === 'lead.setStage' ? 'lead' : 'order',
        entityId,
        deviceCode: PANEL_B,
        hlc: hlcFor(PANEL_B, offsetMs),
        fields: ['stageId'],
        payload: { stageId },
      });

    function collectConflicts() {
      const seen: string[] = [];
      const stop = onConflict((conflict) => seen.push(conflict.field));
      return { seen, stop };
    }

    it('records a stale offline lead move as a stageId conflict and keeps the newer stage', async () => {
      const lead = await aLead();
      await leads.setStage({ id: lead.id, stageId: await stageIdByName('lead', 'Negotiating') }, actor);
      const published = collectConflicts();

      const stale = stageMove('lead.setStage', lead.id, await stageIdByName('lead', 'Quoted'), -60_000);
      const { results } = await sync.applyPush({ mutations: [stale] }, actor);
      published.stop();

      expect(results[0]?.status).toBe('merged');
      expect(results[0]?.conflicts[0]?.field).toBe('stageId');
      expect((await leads.getLead(lead.id, actor)).stageName).toBe('Negotiating');
      const rows = await db()('sync_conflicts').select('field', 'entity_id');
      expect(rows).toEqual([{ field: 'stageId', entity_id: lead.id }]);
      expect(published.seen).toEqual(['stageId']);

      // Replayed, it is the recorded outcome, not a second conflict.
      const again = await sync.applyPush({ mutations: [stale] }, actor);
      expect(again.results[0]?.status).toBe('duplicate');
      expect(await db()('sync_conflicts').select('id')).toHaveLength(1);
    });

    it('applies a newer offline lead move and stamps the stage clock with its HLC', async () => {
      const lead = await aLead();
      await leads.setStage({ id: lead.id, stageId: await stageIdByName('lead', 'Negotiating') }, actor);

      const newer = stageMove('lead.setStage', lead.id, await stageIdByName('lead', 'Quoted'), 200_000);
      const { results } = await sync.applyPush({ mutations: [newer] }, actor);

      expect(results[0]?.status).toBe('applied');
      const after = await leads.getLead(lead.id, actor);
      expect(after.stageName).toBe('Quoted');
      expect(after.sync.fieldHlc.stageId).toBe(newer.hlc);
      expect(await db()('sync_conflicts').select('id')).toHaveLength(0);
    });

    it('applies a move made offline after an offline create, though both reach the Master later', async () => {
      const { party, product } = await seed();
      const temporaryId = formatTemporaryId(PANEL_B, 41);
      const created = mutation({
        kind: 'lead.create',
        entity: 'lead',
        entityId: temporaryId,
        deviceCode: PANEL_B,
        hlc: hlcFor(PANEL_B, -600_000),
        payload: {
          partyId: party.id,
          items: [{ productId: product.id, variantId: product.variants[0]!.id, quantity: 1, packaging: 'carton' }],
        },
      });
      // Older than the moment the create is applied here: the create's fields
      // carry its own HLC, so this is still the newer write.
      const moved = stageMove('lead.setStage', temporaryId, await stageIdByName('lead', 'Quoted'), -300_000);

      const { results } = await sync.applyPush({ mutations: [created, moved] }, actor);

      expect(results.map((result) => result.status)).toEqual(['applied', 'applied']);
      expect((await leads.getLead(results[0]!.entityId, actor)).stageName).toBe('Quoted');
    });

    it('orders offline order moves the same way', async () => {
      const lead = await aLead();
      const order = await orders.convertLead({ leadId: lead.id }, actor);
      await orders.setStage({ id: order.id, stageId: await stageIdByName('order', 'Postpone') }, actor);

      const stale = stageMove('order.setStage', order.id, await stageIdByName('order', 'Cancelled'), -60_000);
      const first = await sync.applyPush({ mutations: [stale] }, actor);
      expect(first.results[0]?.status).toBe('merged');
      expect((await orders.getOrder(order.id, actor)).stageName).toBe('Postpone');
      expect(await db()('sync_conflicts').where({ field: 'stageId' }).select('id')).toHaveLength(1);

      const newer = stageMove('order.setStage', order.id, await stageIdByName('order', 'Cancelled'), 200_000);
      const second = await sync.applyPush({ mutations: [newer] }, actor);
      expect(second.results[0]?.status).toBe('applied');
      const after = await orders.getOrder(order.id, actor);
      expect(after.stageName).toBe('Cancelled');
      expect(after.sync.fieldHlc.stageId).toBe(newer.hlc);
    });

    it('applies an older Office’s move on arrival, however old its clock', async () => {
      const lead = await aLead();
      await leads.setStage({ id: lead.id, stageId: await stageIdByName('lead', 'Negotiating') }, actor);

      // A protocol 2 Office never folds the Master's change clocks into its own,
      // so a live drag from a PC whose clock runs behind still wins.
      const behind = stageMove('lead.setStage', lead.id, await stageIdByName('lead', 'Quoted'), -60_000);
      const { results } = await sync.applyPush({ mutations: [behind] }, actor, undefined, 2);

      expect(results[0]?.status).toBe('applied');
      expect((await leads.getLead(lead.id, actor)).stageName).toBe('Quoted');
      expect(await db()('sync_conflicts').select('id')).toHaveLength(0);
    });

    it('puts a losing stage back through the stage move, timeline included', async () => {
      const lead = await aLead();
      await leads.setStage({ id: lead.id, stageId: await stageIdByName('lead', 'Negotiating') }, actor);
      await sync.applyPush(
        { mutations: [stageMove('lead.setStage', lead.id, await stageIdByName('lead', 'Quoted'), -60_000)] },
        actor,
      );

      const [conflict] = await conflicts.listConflicts(actor);
      await conflicts.resolveConflict({ conflictId: conflict!.id, action: 'restoreLoser' }, actor);

      expect((await leads.getLead(lead.id, actor)).stageName).toBe('Quoted');
      expect(await conflicts.listConflicts(actor)).toHaveLength(0);
      const moves = await db()('timeline_entries')
        .where({ parent_id: lead.id, kind: 'system' })
        .select('message');
      expect(moves.map((row) => row.message)).toContain('Moved from Negotiating to Quoted');
    });
  });

  describe('a chat post (Phase 6)', () => {
    /** A real person, a room they are in, and the actor their session resolves to. */
    async function author(username: string) {
      const role = await roleService.createRole(
        { name: `Chat ${username}`, tier: 'management', permissions: ['chat.use', 'chat.createGroups'] },
        actor,
      );
      const { user } = await userService.createUser(
        { username, displayName: username, roleId: role.id, password: 'correct-horse' },
        actor,
      );
      const asUser = {
        ...(await actorWith(['chat.use', 'chat.createGroups'])),
        actorId: user.id,
        userId: user.id,
        actorName: username,
      };
      const room = await chat.createRoom({ name: `Room ${username}` }, asUser);
      return { user, asUser, roomId: room.id };
    }

    const post = (roomId: string, actorUserId: string | null, body = 'hello from the shop floor') =>
      mutation({
        kind: 'chat.post',
        entity: 'chat_message',
        entityId: formatTemporaryId(PANEL_A, 41),
        payload: { roomId, body },
        actorUserId,
      });

    it('creates the message, maps its temporary id, and replays as a duplicate with one row', async () => {
      const { user, asUser, roomId } = await author('asha');
      const m = post(roomId, user.id);

      const first = await sync.applyPush({ mutations: [m] }, asUser);
      expect(first.results[0]?.status).toBe('applied');
      expect(first.results[0]?.entityId).toMatch(/^CM\d{10}$/);
      expect(first.idMappings.map((mapping) => mapping.temporaryId)).toEqual([m.entityId]);

      const second = await sync.applyPush({ mutations: [m] }, asUser);
      expect(second.results[0]?.status).toBe('duplicate');
      expect(await db()('chat_messages').where({ room_id: roomId, kind: 'text' })).toHaveLength(1);
    });

    it('is never applied as somebody else: a post by A pushed under B is rejected and recorded', async () => {
      const a = await author('asha');
      const b = await author('bina');
      const m = post(a.roomId, a.user.id);

      const { results } = await sync.applyPush({ mutations: [m] }, b.asUser);
      expect(results[0]?.status).toBe('rejected');
      expect(results[0]?.error).toMatch(/someone else/i);
      expect(await db()('chat_messages').where({ room_id: a.roomId, kind: 'text' })).toHaveLength(0);

      // Replayed as the refusal it was, not tried again as A.
      const again = await sync.applyPush({ mutations: [m] }, a.asUser);
      expect(again.results[0]?.status).toBe('duplicate');
    });

    it('rejects a post by a person without chat.use, naming the key', async () => {
      const { user, roomId } = await author('asha');
      const limited = { ...(await actorWith(['leads.view'])), actorId: user.id, userId: user.id };

      const { results } = await sync.applyPush({ mutations: [post(roomId, user.id)] }, limited);
      expect(results[0]).toMatchObject({ status: 'rejected', missingPermission: 'chat.use' });
    });

    it('applies a lead pushed beside a post by a signed-out user, and refuses the post without a 503', async () => {
      const { party, product } = await seed();
      const { user, roomId } = await author('asha');
      const lead = mutation({
        kind: 'lead.create',
        entity: 'lead',
        payload: {
          partyId: party.id,
          items: [{ productId: product.id, variantId: product.variants[0]!.id, quantity: 2, packaging: 'carton' }],
        },
      });

      // Under the bare panel role, which cannot chat: the Office would never send this, so the Master's answer is the net.
      const held = post(roomId, user.id);
      const response = await sync.applyPush(
        { mutations: [lead, held] },
        { ...actor, actorType: 'office_panel' },
      );
      const statusOf = (id: string) => response.results.find((result) => result.mutationId === id)?.status;
      expect(statusOf(lead.mutationId)).toBe('applied');
      expect(statusOf(held.mutationId)).toBe('rejected');
      expect(await db()('leads').select('id')).toHaveLength(1);
      expect(await db()('chat_messages').where({ room_id: roomId, kind: 'text' })).toHaveLength(0);
    });
  });

  describe('refusals', () => {
    it('rejects a mutation the panel’s role may not make, naming the permission', async () => {
      const { party, product } = await seed();
      const limited = await actorWith(['leads.view']);

      const response = await sync.applyPush(
        {
          mutations: [
            mutation({
              kind: 'lead.create',
              entity: 'lead',
              payload: {
                partyId: party.id,
                items: [
                  {
                    productId: product.id,
                    variantId: product.variants[0]!.id,
                    quantity: 1,
                    packaging: 'carton',
                  },
                ],
              },
            }),
          ],
        },
        limited,
      );

      expect(response.results[0]?.status).toBe('rejected');
      expect(response.results[0]?.missingPermission).toBe('leads.create');
      expect(await db()('leads').select('id')).toHaveLength(0);
    });

    it('replays a refusal rather than retrying it', async () => {
      const limited = await actorWith(['leads.view']);
      const only = mutation({
        kind: 'lead.create',
        entity: 'lead',
        payload: { partyId: 'PT0000000001', items: [] },
      });

      const first = await sync.applyPush({ mutations: [only] }, limited);
      const second = await sync.applyPush({ mutations: [only] }, limited);

      expect(first.results[0]?.status).toBe('rejected');
      expect(second.results[0]?.status).toBe('duplicate');
    });
  });
});

/**
 * The merge path writes columns directly — it is documented as bypassing the
 * services — so every constrained column added to it is a new way for offline
 * work to be permanently destroyed. A CHECK violation there is caught, recorded
 * as a `rejected` result, and replayed as that rejection forever.
 *
 * The mitigation is that the same validator the service runs also runs here, so
 * a bad value comes back as a sentence rather than as a Postgres error nobody
 * can act on.
 */
describe.skipIf(!canRunIntegrationTests)('merging a product edit (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    actor = await testActor({ deviceCode: PANEL_A, actorType: 'office_panel' });
  });

  async function existingProduct() {
    return catalog.createProduct(
      {
        categoryName: 'Tiles',
        variants: [{ code: 'MRG-01', weightKg: 20 }],
        name: 'Merge Tile',
        size: '600x600',
      },
      actor,
    );
  }

  const reload = (id: string) => catalog.getProduct(id, actor);

  it('accepts a valid attribute edit made offline', async () => {
    const product = await existingProduct();

    const response = await sync.applyPush(
      {
        mutations: [
          mutation({
            kind: 'product.update',
            entity: 'product',
            entityId: product.id,
            fields: ['alias', 'multiColour'],
            payload: { alias: 'Merge', multiColour: true },
            baseFieldHlc: product.sync.fieldHlc,
          }),
        ],
      },
      actor,
    );

    expect(response.results[0]?.status).not.toBe('rejected');
    const after = await reload(product.id);
    expect(after.alias).toBe('Merge');
    expect(after.multiColour).toBe(true);
  });

  it('refuses an offline rename onto a live sibling of the same product, and writes nothing', async () => {
    const product = await existingProduct();
    await catalog.createProduct(
      { categoryName: 'Tiles', variants: [{ code: 'MRG-02' }], name: 'Other Tile' },
      actor,
    );

    const response = await sync.applyPush(
      {
        mutations: [
          mutation({
            kind: 'product.update',
            entity: 'product',
            entityId: product.id,
            fields: ['name'],
            payload: { name: 'OTHER TILE' },
            baseFieldHlc: product.sync.fieldHlc,
          }),
        ],
      },
      actor,
    );

    expect(response.results[0]?.status).toBe('rejected');
    expect(response.results[0]?.error ?? '').toMatch(/Other Tile/i);
    expect((await reload(product.id)).name).toBe('Merge Tile');
  });

  it('refuses a variant set the rules could never accept, with a reason', async () => {
    const product = await existingProduct();

    const response = await sync.applyPush(
      {
        mutations: [
          mutation({
            kind: 'product.update',
            entity: 'product',
            entityId: product.id,
            fields: ['variants'],
            payload: { variants: [{ code: 'MRG-01', label: null, weightKg: -4 }] },
            baseFieldHlc: product.sync.fieldHlc,
          }),
        ],
      },
      actor,
    );

    const result = response.results[0];
    expect(result?.status).toBe('rejected');
    // A sentence, not `new row for relation "product_variants" violates
    // check constraint "product_variants_weight_check"`.
    expect(result?.error ?? '').toMatch(/weight/i);

    // …and nothing was written.
    expect((await reload(product.id)).variants[0]?.weightKg).toBe(20);
  });

  it('ignores an unresolvable category id and keeps the rest of the edit', async () => {
    const product = await existingProduct();

    const response = await sync.applyPush(
      {
        mutations: [
          mutation({
            kind: 'product.update',
            entity: 'product',
            entityId: product.id,
            fields: ['categoryId', 'alias'],
            payload: { categoryId: 'CT0000000099', alias: 'Kept' },
            baseFieldHlc: product.sync.fieldHlc,
          }),
        ],
      },
      actor,
    );

    // The merge does move a category, but only onto one that exists. A stale
    // id (a panel offline since before a category was removed) would
    // otherwise be a foreign key error recorded as a permanent refusal, so it
    // is dropped and the other fields of the same edit still land.
    expect(response.results[0]?.status).toBe('applied');
    const after = await reload(product.id);
    expect(after.categoryId).toBe(product.categoryId);
    expect(after.alias).toBe('Kept');
    expect(after.sync.fieldHlc.categoryId).toBe(product.sync.fieldHlc.categoryId);
  });

  describe('moving a sub product to another main product', () => {
    async function inTwoCategories() {
      const product = await existingProduct();
      const basin = await catalog.createProduct(
        { categoryName: 'Basins', variants: [{ code: 'MRG-B1' }], name: 'Basin One' },
        actor,
      );
      return { product, target: basin.categoryId };
    }

    const move = (productId: string, categoryId: string, overrides: Partial<Mutation> = {}) =>
      mutation({
        kind: 'product.update',
        entity: 'product',
        entityId: productId,
        fields: ['categoryId'],
        payload: { categoryId },
        ...overrides,
      });

    it('applies a newer move through the field clock', async () => {
      const { product, target } = await inTwoCategories();

      const response = await sync.applyPush(
        { mutations: [move(product.id, target, { baseFieldHlc: product.sync.fieldHlc })] },
        actor,
      );

      expect(response.results[0]?.status).toBe('applied');
      expect((await reload(product.id)).categoryId).toBe(target);
    });

    it('lets an older panel move lose to the Master\'s, and records it', async () => {
      const { product, target } = await inTwoCategories();
      const [tiles] = (await catalog.listCategories(actor)).filter((category) => category.id !== target);
      // The Master moves it first.
      await catalog.updateProduct(product.id, { name: product.name, categoryId: target }, actor);

      const response = await sync.applyPush(
        { mutations: [move(product.id, tiles!.id, { hlc: hlcFor(PANEL_A, -1_000_000_000) })] },
        actor,
      );

      expect(response.results[0]?.conflicts.map((conflict) => conflict.field)).toEqual(['categoryId']);
      expect((await reload(product.id)).categoryId).toBe(target);
    });

    it('refuses a move onto a main product that already has that name', async () => {
      const { product, target } = await inTwoCategories();
      await catalog.createProduct(
        { categoryId: target, variants: [{ code: 'MRG-B2' }], name: 'Merge Tile' },
        actor,
      );

      const response = await sync.applyPush(
        { mutations: [move(product.id, target, { baseFieldHlc: product.sync.fieldHlc })] },
        actor,
      );

      expect(response.results[0]?.status).toBe('rejected');
      expect(response.results[0]?.error ?? '').toMatch(/already has a sub product named/i);
      expect((await reload(product.id)).categoryId).toBe(product.categoryId);
    });

    it('puts a losing category back, if that category is still there', async () => {
      const { product, target } = await inTwoCategories();
      await sync.applyPush(
        { mutations: [move(product.id, target, { baseFieldHlc: product.sync.fieldHlc })] },
        actor,
      );
      // A second panel's older move to the original category loses and is recorded.
      await sync.applyPush(
        { mutations: [move(product.id, product.categoryId, { hlc: hlcFor(PANEL_A, -1_000_000_000) })] },
        actor,
      );

      const [conflict] = await conflicts.listConflicts(actor);
      expect(conflict?.field).toBe('categoryId');
      await conflicts.resolveConflict({ conflictId: conflict!.id, action: 'restoreLoser' }, actor);

      expect((await reload(product.id)).categoryId).toBe(product.categoryId);
    });
  });

  it('replaces the variant set as one field, keeping the ids stock is keyed by', async () => {
    const product = await existingProduct();
    const [existing] = product.variants;

    const response = await sync.applyPush(
      {
        mutations: [
          mutation({
            kind: 'product.update',
            entity: 'product',
            entityId: product.id,
            fields: ['hasVariants', 'variants'],
            payload: {
              hasVariants: true,
              variants: [
                { id: existing!.id, code: 'MRG-01', label: 'White', weightKg: 21 },
                { code: 'MRG-02', label: 'Blue', weightKg: 22 },
              ],
            },
            baseFieldHlc: product.sync.fieldHlc,
          }),
        ],
      },
      actor,
    );

    expect(response.results[0]?.status).toBe('applied');
    const after = await reload(product.id);
    expect(after.hasVariants).toBe(true);
    expect(after.variants.map((variant) => [variant.id === existing!.id, variant.code, variant.label, variant.weightKg])).toEqual([
      [true, 'MRG-01', 'White', 21],
      [false, 'MRG-02', 'Blue', 22],
    ]);
    expect(after.sync.fieldHlc.variants).toBeDefined();
  });

  it('records a losing variant set as one conflict rather than merging rows', async () => {
    const product = await existingProduct();
    const [existing] = product.variants;

    // The Master's own edit lands first, stamping `variants`.
    const online = await catalog.updateProduct(
      product.id,
      { name: product.name, variants: [{ id: existing!.id, code: 'MRG-01', weightKg: 30 }] },
      await testActor(),
    );

    // A panel that never saw that edit pushes an older set with an older clock.
    const response = await sync.applyPush(
      {
        mutations: [
          mutation({
            kind: 'product.update',
            entity: 'product',
            entityId: product.id,
            fields: ['variants'],
            payload: { variants: [{ id: existing!.id, code: 'MRG-01', weightKg: 25 }] },
            baseFieldHlc: product.sync.fieldHlc,
            // Far in the past: older than anything the Master has stamped.
            hlc: hlcFor(PANEL_A, -1_000_000_000),
          }),
        ],
      },
      actor,
    );

    expect(response.results[0]?.conflicts.map((conflict) => conflict.field)).toEqual(['variants']);
    expect((await reload(product.id)).variants[0]?.weightKg).toBe(30);
    expect(online.variants[0]?.weightKg).toBe(30);
  });

  it('puts a losing variant set back', async () => {
    const product = await existingProduct();
    const [existing] = product.variants;
    await catalog.updateProduct(
      product.id,
      { name: product.name, variants: [{ id: existing!.id, code: 'MRG-01', weightKg: 30 }] },
      await testActor(),
    );
    await sync.applyPush(
      {
        mutations: [
          mutation({
            kind: 'product.update',
            entity: 'product',
            entityId: product.id,
            fields: ['variants'],
            payload: { variants: [{ id: existing!.id, code: 'MRG-01', weightKg: 25 }] },
            hlc: hlcFor(PANEL_A, -1_000_000_000),
          }),
        ],
      },
      actor,
    );

    const [conflict] = await conflicts.listConflicts(actor);
    expect(conflict?.field).toBe('variants');
    await conflicts.resolveConflict({ conflictId: conflict!.id, action: 'restoreLoser' }, actor);

    const after = await reload(product.id);
    expect(after.variants[0]?.weightKg).toBe(25);
    // Same variant row, so the stock keyed by it is not orphaned.
    expect(after.variants[0]?.id).toBe(existing!.id);
  });

  it('refuses a variant set that breaks the rules, with a reason', async () => {
    const product = await existingProduct();

    const response = await sync.applyPush(
      {
        mutations: [
          mutation({
            kind: 'product.update',
            entity: 'product',
            entityId: product.id,
            fields: ['variants'],
            payload: { variants: [{ code: 'MRG-01', weightKg: -1 }] },
            baseFieldHlc: product.sync.fieldHlc,
          }),
        ],
      },
      actor,
    );

    expect(response.results[0]?.status).toBe('rejected');
    expect(response.results[0]?.error ?? '').toMatch(/greater than zero/i);
    expect((await reload(product.id)).variants[0]?.weightKg).toBe(20);
  });
});
