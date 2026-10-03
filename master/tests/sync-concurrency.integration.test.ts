/**
 * PO numbers under concurrent sync (1.3 rule 2, `identity.repository.ts`).
 *
 * The number is minted inside the transaction that creates the lead, from a
 * row-locked counter, and every push goes through the push gate. Together that
 * has to give: ten panels pushing at once get ten contiguous numbers in HLC
 * order; a create that is refused takes no number; and a push replayed after a
 * lost acknowledgement answers with the number it was first given.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Mutation } from '@orderbook/shared';
import {
  compareHlc,
  financialYearLabel,
  formatPendingOrderNumber,
  formatTemporaryId,
  initialHlcState,
  tickHlc,
} from '@orderbook/shared';

import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';
import { db } from '../src/db/knex.js';
import type { ActorContext } from '../src/domain/actor.js';
import * as catalog from '../src/services/catalog.service.js';
import { __resetGateForTests, configurePushGate } from '../src/services/push-gate.js';
import * as sync from '../src/services/sync.service.js';

let admin: ActorContext;
let item: { partyId: string; line: Record<string, unknown> };

// Not registered panels, so `actorId` stays null (see `push-gate.integration`).
const panel = (deviceCode: string) => ({ ...admin, actorType: 'office_panel' as const, actorId: null, deviceCode });

function create(deviceCode: string, offsetMs: number, partyId = item.partyId): Mutation {
  return {
    mutationId: `m-${deviceCode}-${Math.random().toString(36).slice(2)}`,
    kind: 'lead.create',
    entity: 'lead',
    entityId: formatTemporaryId(deviceCode, 1),
    hlc: tickHlc(initialHlcState(deviceCode), Date.now() + offsetMs).hlc,
    deviceCode,
    payload: { partyId, items: [item.line] },
    fields: [],
    baseFieldHlc: {},
    actorUserId: null,
    createdAt: new Date().toISOString(),
  };
}

const push = (deviceCode: string, ...mutations: Mutation[]) =>
  sync.applyPush({ mutations }, panel(deviceCode));

/** The number the `sequence`th lead of this financial year gets. */
const po = (sequence: number) => formatPendingOrderNumber(financialYearLabel(new Date()), sequence);

describe.skipIf(!canRunIntegrationTests)('PO numbers under concurrent sync (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    admin = await testActor();
    const party = await catalog.createParty({ name: 'Concurrent Traders' }, admin);
    const product = await catalog.createProduct(
      { categoryName: 'Tiles', variants: [{ code: 'CONC-01' }], name: 'Concurrent Tile' },
      admin,
    );
    item = {
      partyId: party.id,
      line: { productId: product.id, variantId: product.variants[0]!.id, quantity: 1, packaging: 'carton' },
    };
    __resetGateForTests();
  });
  afterEach(() => {
    __resetGateForTests();
    configurePushGate({ windowMs: 0, backlogMs: 0, bootMs: 0 });
  });

  it('gives ten panels pushing at once PO 00001 to 00010, contiguous and in HLC order', async () => {
    configurePushGate({ windowMs: 400, backlogMs: 6_000, bootMs: 0 });
    // Device codes use the 30-character alphabet (no 0, 1, I, L, O or U).
    const devices = ['2', '3', '4', '5', '6', '7', '8', '9', 'A', 'B'].map((tail) => `PANEX${tail}`);
    // Clocks in the reverse of the order the pushes are made, so arrival
    // order and HLC order disagree.
    const mutations = devices.map((device, index) => create(device, (devices.length - index) * 50));

    const responses = await Promise.all(devices.map((device, index) => push(device, mutations[index]!)));

    const results = responses.map((response) => response.results[0]!);
    expect(results.map((result) => result.status)).toEqual(Array(10).fill('applied'));
    const byHlc = mutations
      .map((mutation, index) => ({ hlc: mutation.hlc, number: results[index]!.number }))
      .sort((a, b) => compareHlc(a.hlc, b.hlc))
      .map((entry) => entry.number);
    expect(byHlc).toEqual(Array.from({ length: 10 }, (_, index) => po(index + 1)));

    // The stored numbers are the ones the panels were told.
    const stored = await db()('leads').orderBy('po_number').pluck('po_number');
    expect(stored).toEqual(byHlc);
  });

  it('takes no number for a create that is refused', async () => {
    configurePushGate({ windowMs: 0, backlogMs: 0, bootMs: 0 });

    const refused = await push('PANEXC', create('PANEXC', 0, 'PT9999999999'));
    expect(refused.results[0]?.status).toBe('rejected');
    expect(refused.results[0]?.number).toBeUndefined();

    const accepted = await push('PANEXC', create('PANEXC', 10));
    expect(accepted.results[0]?.number).toBe(po(1));
  });

  it('answers a replayed push with the number it was first given', async () => {
    configurePushGate({ windowMs: 0, backlogMs: 0, bootMs: 0 });
    const mutation = create('PANEXD', 0);

    const first = await push('PANEXD', mutation);
    const replay = await push('PANEXD', mutation);

    expect(first.results[0]).toMatchObject({ status: 'applied', number: po(1) });
    expect(replay.results[0]).toMatchObject({ status: 'duplicate', number: po(1) });
    expect(await db()('leads').count<{ count: string }>({ count: '*' }).first()).toMatchObject({ count: '1' });
  });
});
