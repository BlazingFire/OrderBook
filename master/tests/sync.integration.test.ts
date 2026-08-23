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
import * as conflicts from '../src/services/conflict.service.js';
import * as leads from '../src/services/lead.service.js';
import * as sync from '../src/services/sync.service.js';

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
      { productCode: 'OFF-01', name: 'Matte Tile', rate: 20_000 },
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
                    packaging: 'carton',
                    quantities: [{ colour: 'Ivory', quantity: 3 }],
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
              packaging: 'carton',
              quantities: [{ colour: 'Ivory', quantity: 1 }],
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

    it('numbers a batch by (hlc, device), not by arrival order', async () => {
      const { party, product } = await seed();

      const item = {
        productId: product.id,
        packaging: 'carton',
        quantities: [{ colour: 'Ivory', quantity: 1 }],
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
              packaging: 'carton',
              quantities: [{ colour: 'Ivory', quantity: 2 }],
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
                    packaging: 'carton',
                    quantities: [{ colour: 'Ivory', quantity: 1 }],
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
                    packaging: 'carton',
                    quantities: [{ colour: 'Ivory', quantity: 1 }],
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
