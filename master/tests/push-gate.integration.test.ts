/**
 * The Master's push gate (`push-gate.ts`, rule 6).
 *
 * Every `sync:push` waits in one gate, is sorted by HLC with the pushes that
 * arrived with it, and is applied one mutation at a time. These pin what that
 * buys and what it must not cost: ten panels pushing at once no longer starve
 * the connection pool, creates are numbered by HLC within a gather window, a
 * push that fails retryably takes nothing of its own with it half-done and
 * nothing of anybody else's, a panel's retry merges with its waiting push, and
 * the boot window still answers inside a 1.2 Office's 15 s ack.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mutation } from '@orderbook/shared';
import { formatTemporaryId, initialHlcState, tickHlc } from '@orderbook/shared';

import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, stageIdByName, teardownDatabase, testActor } from './helpers/fixtures.js';
import { db } from '../src/db/knex.js';
import type { ActorContext } from '../src/domain/actor.js';
import * as catalog from '../src/services/catalog.service.js';
import * as leads from '../src/services/lead.service.js';
import { __resetGateForTests, configurePushGate } from '../src/services/push-gate.js';
import * as sync from '../src/services/sync.service.js';

const PANEL_A = 'A3F9K2';
const PANEL_B = 'B7QMX4';

const hlcFor = (deviceCode: string, offsetMs: number) =>
  tickHlc(initialHlcState(deviceCode), Date.now() + offsetMs).hlc;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let admin: ActorContext;
let item: Record<string, unknown>;

// `actorId` is the panel's `office_panels.id` in production (a uuid, stored as
// `leads.source_panel_id`); these panels are not registered, so it stays null.
const panel = (deviceCode: string) => ({ ...admin, actorType: 'office_panel' as const, actorId: null, deviceCode });

function create(deviceCode: string, sequence: number, offsetMs: number): Mutation {
  return {
    mutationId: `m-${deviceCode}-${sequence}-${Math.random().toString(36).slice(2)}`,
    kind: 'lead.create',
    entity: 'lead',
    entityId: formatTemporaryId(deviceCode, sequence),
    hlc: hlcFor(deviceCode, offsetMs),
    deviceCode,
    payload: { partyId: item.partyId, items: [item.line] },
    fields: [],
    baseFieldHlc: {},
    actorUserId: null,
    createdAt: new Date().toISOString(),
  };
}

const push = (deviceCode: string, ...mutations: Mutation[]) =>
  sync.applyPush({ mutations }, panel(deviceCode));

describe.skipIf(!canRunIntegrationTests)('push gate (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    admin = await testActor();
    const party = await catalog.createParty({ name: 'Gate Traders' }, admin);
    const product = await catalog.createProduct(
      { categoryName: 'Tiles', variants: [{ code: 'GATE-01' }], name: 'Gate Tile' },
      admin,
    );
    item = {
      partyId: party.id,
      line: { productId: product.id, variantId: product.variants[0]!.id, quantity: 1, packaging: 'carton' },
    };
    __resetGateForTests();
    configurePushGate({ windowMs: 100, backlogMs: 6_000, bootMs: 0 });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    __resetGateForTests();
    configurePushGate({ windowMs: 0, backlogMs: 0, bootMs: 0 });
  });

  it('applies ten panels pushing at once without exhausting the pool', async () => {
    // Device codes use the 30-character alphabet (no 0, 1, I, L, O or U).
    const devices = ['2', '3', '4', '5', '6', '7', '8', '9', 'A', 'B'].map((tail) => `PANEX${tail}`);

    // Each `applyOne` holds a pooled connection for its advisory lock while
    // the services take others; ten at once held all ten of the pool's and
    // waited for an eleventh until `TimeoutAcquiringConnection`.
    const responses = await Promise.all(devices.map((device, index) => push(device, create(device, 1, index))));

    const results = responses.flatMap((response) => response.results);
    expect(results.map((result) => result.status)).toEqual(Array(10).fill('applied'));
    expect(new Set(results.map((result) => result.entityId)).size).toBe(10);
    expect(await db()('leads').select('id')).toHaveLength(10);
  });

  it('numbers creates by HLC, not arrival, within the gather window', async () => {
    configurePushGate({ windowMs: 400 });
    const later = create(PANEL_B, 1, 2_000);
    const earlier = create(PANEL_A, 1, 1_000);

    const fromB = push(PANEL_B, later);
    await pause(50);
    const fromA = push(PANEL_A, earlier);
    const [b, a] = await Promise.all([fromB, fromA]);

    expect(a.results[0]?.entityId).toBe('LD0000000001');
    expect(b.results[0]?.entityId).toBe('LD0000000002');
  });

  it('orders two offline backlogs that reach the Master 3 s apart', async () => {
    // Both creates are over 10 s old, so the first push opens the 6 s window.
    const later = create(PANEL_B, 1, -55_000);
    const earlier = create(PANEL_A, 1, -60_000);

    const fromB = push(PANEL_B, later);
    await pause(3_000);
    const fromA = push(PANEL_A, earlier);
    const [b, a] = await Promise.all([fromB, fromA]);

    expect(a.results[0]?.entityId).toBe('LD0000000001');
    expect(b.results[0]?.entityId).toBe('LD0000000002');
  });

  it("gathers a panel's backlog once per connection, not once per batch", async () => {
    const connectedAt = Date.now();
    const started = Date.now();
    await sync.applyPush({ mutations: [create(PANEL_A, 1, -60_000)] }, panel(PANEL_A), connectedAt);
    expect(Date.now() - started).toBeGreaterThanOrEqual(5_900);

    // The next batch of the same backlog, on the same connection.
    const next = Date.now();
    await sync.applyPush({ mutations: [create(PANEL_A, 2, -59_000)] }, panel(PANEL_A), connectedAt);
    expect(Date.now() - next).toBeLessThan(2_000);
  });

  it('does not take an old-looking create long after connecting for a backlog', async () => {
    // A PC whose clock is behind the Master's stamps live creates in the past.
    const started = Date.now();
    await sync.applyPush({ mutations: [create(PANEL_A, 1, -60_000)] }, panel(PANEL_A), Date.now() - 120_000);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('fails only the push whose create failed retryably, and records none of it', async () => {
    configurePushGate({ windowMs: 300 });
    const original = leads.createLead;
    vi.spyOn(leads, 'createLead').mockImplementation(async (input, actor, madeAt) => {
      if (actor.deviceCode === PANEL_A) {
        throw Object.assign(new Error('could not serialize access'), { code: '40001' });
      }
      return original(input, actor, madeAt);
    });

    const failing = create(PANEL_A, 1, 1_000);
    // Depends on the create above: applied after it failed, it would be
    // recorded as a refusal for a lead that does not exist yet.
    const dependent: Mutation = {
      ...create(PANEL_A, 1, 2_000),
      mutationId: `m-stage-${Math.random().toString(36).slice(2)}`,
      kind: 'lead.setStage',
      payload: { stageId: await stageIdByName('lead', 'Quoted') },
      fields: ['stageId'],
    };
    const other = create(PANEL_B, 1, 1_500);

    const [a, b] = await Promise.allSettled([push(PANEL_A, failing, dependent), push(PANEL_B, other)]);

    expect(a.status).toBe('rejected');
    expect(b.status).toBe('fulfilled');
    expect(b.status === 'fulfilled' && b.value.results[0]?.status).toBe('applied');
    const recorded = await db()('applied_mutations').select<Array<{ mutation_id: string }>>('mutation_id');
    expect(recorded.map((row) => row.mutation_id)).toEqual([other.mutationId]);

    // The panel's retry then applies both, in order.
    vi.restoreAllMocks();
    const retry = await push(PANEL_A, failing, dependent);
    expect(retry.results.map((result) => result.status)).toEqual(['applied', 'applied']);
    expect((await leads.getLead(retry.results[0]!.entityId, admin)).stageName).toBe('Quoted');
  });

  it('merges a panel\'s retry into its push still waiting, and answers both', async () => {
    configurePushGate({ windowMs: 300 });
    const first = create(PANEL_A, 1, 1_000);
    const second = create(PANEL_A, 2, 2_000);

    const original = push(PANEL_A, first);
    await pause(50);
    const retry = push(PANEL_A, first, second);
    const [one, both] = await Promise.all([original, retry]);

    // Merged, the retry's copy of `first` is the same application, not a
    // second entry finding it already applied ('duplicate').
    expect(one.results.map((result) => result.status)).toEqual(['applied']);
    expect(both.results.map((result) => result.status)).toEqual(['applied', 'applied']);
    expect(both.results[0]?.entityId).toBe(one.results[0]?.entityId);
    expect(await db()('leads').select('id')).toHaveLength(2);
  });

  it('answers within a 1.2 Office\'s 15 s ack while gathering after boot', async () => {
    __resetGateForTests();
    configurePushGate({ bootMs: 5_000 });

    const started = Date.now();
    const response = await push(PANEL_A, create(PANEL_A, 1, 1_000));
    const elapsed = Date.now() - started;

    expect(response.results[0]?.status).toBe('applied');
    expect(elapsed).toBeGreaterThanOrEqual(4_900);
    expect(elapsed).toBeLessThan(15_000);
  });
});
