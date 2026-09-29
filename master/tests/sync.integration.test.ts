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

  it('does not merge a category assignment', async () => {
    const product = await existingProduct();

    const response = await sync.applyPush(
      {
        mutations: [
          mutation({
            kind: 'product.update',
            entity: 'product',
            entityId: product.id,
            fields: ['categoryId'],
            payload: { categoryId: 'CT0000000099' },
            baseFieldHlc: product.sync.fieldHlc,
          }),
        ],
      },
      actor,
    );

    // Category is deliberately absent from `MERGEABLE_PRODUCT_COLUMNS`. The
    // merge cannot run `resolveCategoryId`, so a stale id would be a foreign
    // key error rather than a rename — assignment stays an online operation.
    expect(response.results[0]?.status).not.toBe('rejected');
    expect((await reload(product.id)).categoryId).toBe(product.categoryId);
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
