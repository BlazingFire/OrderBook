/**
 * A panel that replays a delta must end up holding the same rows as one that
 * took a fresh snapshot.
 *
 * The comparison is **id-keyed maps of row id to `sync.version`, order-
 * insensitive**, and that is not a weakening of the test — byte-identical is
 * unachievable and asserting it would only be asserting on incidentals.
 * `upsert` prepends while `buildSnapshot` orders by name or id, and snapshot
 * rows are rate-masked per actor while a `data:changed` payload is raw. What
 * has to match is *which records, at which versions*.
 *
 * The replay runs the panel's own `applyChangeToSnapshot` — the same shared
 * function the panel's server and browser both call. A lookalike written here
 * would pass while the panel diverged.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { applyChangeToSnapshot, type SyncSnapshot } from '@orderbook/shared';

import type { ActorContext } from '../src/domain/actor.js';
import { BOOT_ID, currentSeq, resetChangeRing } from '../src/realtime/change-ring.js';
import * as catalog from '../src/services/catalog.service.js';
import { buildDelta } from '../src/services/delta.service.js';
import * as leads from '../src/services/lead.service.js';
import { buildSnapshot } from '../src/services/snapshot.service.js';
import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';

let admin: ActorContext;

/** Id to version, for every collection a delta can carry. */
function fingerprint(snapshot: SyncSnapshot): Record<string, Record<string, number>> {
  const of = (rows: Array<{ id: string; sync?: { version: number } }>) =>
    Object.fromEntries(rows.map((row) => [row.id, row.sync?.version ?? 0]));

  return {
    leads: of(snapshot.leads),
    orders: of(snapshot.orders),
    parties: of(snapshot.parties),
    products: of(snapshot.products),
    categories: of(snapshot.categories),
  };
}

async function seedParty(name: string) {
  return catalog.createParty({ name }, admin);
}

async function seedLead(partyId: string, productId: string) {
  return leads.createLead(
    {
      partyId,
      items: [
        { productId, packaging: 'carton', quantities: [{ colour: 'Ivory', quantity: 3 }] },
      ],
    },
    admin,
  );
}

describe.skipIf(!canRunIntegrationTests)('reconnect delta (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);

  beforeEach(async () => {
    await resetData();
    resetChangeRing();
    admin = await testActor();
  });

  it('leaves a replaying panel holding what a snapshot-taking one holds', async () => {
    const party = await seedParty('Delta Traders');
    const product = await catalog.createProduct(
      { productCode: 'DL-01', name: 'Glazed Tile', rate: 42_000 },
      admin,
    );

    // What the panel had when it went offline.
    const before = await buildSnapshot(admin);
    const cursor = { bootId: BOOT_ID, lastSeq: before.seq ?? currentSeq() };

    // What happened while it was away.
    await seedLead(party.id, product.id);
    await catalog.updateParty(party.id, { name: 'Delta Traders Ltd' }, admin);
    await catalog.createProduct({ productCode: 'DL-02', name: 'Matt Tile', rate: 39_000 }, admin);

    const delta = await buildDelta(cursor, admin);
    expect(delta).not.toBeNull();
    expect(delta?.events.length).toBeGreaterThan(0);

    const replayed: SyncSnapshot = structuredClone(before);
    for (const event of delta!.events) applyChangeToSnapshot(replayed, event);

    const fresh = await buildSnapshot(admin);
    expect(fingerprint(replayed)).toEqual(fingerprint(fresh));
  });

  it('refuses a cursor from another run of the Master', async () => {
    await seedParty('Other Boot Traders');

    const delta = await buildDelta({ bootId: 'not-this-boot', lastSeq: 0 }, admin);

    // Null is "send a snapshot", which is exactly what a Master restart has
    // always meant: the ring is in memory and there is nothing to replay from.
    expect(delta).toBeNull();
  });

  it('refuses once an event the panel cannot apply is in the range', async () => {
    const before = await buildSnapshot(admin);
    const cursor = { bootId: BOOT_ID, lastSeq: before.seq ?? currentSeq() };

    const party = await seedParty('Variant Traders');
    const product = await catalog.createProduct(
      { productCode: 'DL-03', name: 'Rustic Tile', rate: 12_000 },
      admin,
    );

    // A party variant is a per-party negotiated rate. It is in the snapshot
    // but not as a flat id-keyed list a replayed delta can upsert into, so
    // its presence forces the full snapshot instead — this is `buildDelta`'s
    // own REPLAYABLE_ENTITIES gate, not `applyChangeToSnapshot`'s.
    await catalog.upsertVariant({ partyId: party.id, productId: product.id, rate: 9_000 }, admin);

    expect(await buildDelta(cursor, admin)).toBeNull();
  });

  it('withholds the directory from a replay exactly as the live path does', async () => {
    const before = await buildSnapshot(admin);
    const cursor = { bootId: BOOT_ID, lastSeq: before.seq ?? currentSeq() };

    await seedParty('Directory Traders');

    const delta = await buildDelta(cursor, admin);
    expect(delta).not.toBeNull();

    // Replaying a `user` or `role` row would hand every panel the whole staff
    // list and every role's complete permission array — the disclosure the live
    // fan-out refuses by name.
    for (const event of delta!.events) {
      expect(['role', 'user', 'document_export']).not.toContain(event.entity);
    }
  });

  it('carries the permissions and grants a replay cannot deliver as events', async () => {
    const before = await buildSnapshot(admin);
    const cursor = { bootId: BOOT_ID, lastSeq: before.seq ?? currentSeq() };

    await seedParty('Grant Traders');
    const delta = await buildDelta(cursor, admin);

    // A role can be edited and a grant written while a panel is switched off,
    // and neither arrives as a replayable event.
    expect(delta?.permissions.length).toBeGreaterThan(0);
    expect(delta?.dashboard).toBeDefined();
    expect(delta?.serverHlc).toBeTruthy();
  });
});
