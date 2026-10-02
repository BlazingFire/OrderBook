/**
 * The Office Dashboard against a real cluster — every figure's gating is a
 * statement about what SQL returns for a real actor, and `dispatchedThisWeekCount`
 * needs a real week boundary against `config.locale.timeZone`. Registered in
 * `docs/backend-modules/10-TESTING.md` §6.8 as `DSH-4`…`DSH-9`, moved here
 * from a suite declared pure because none of these gates can be proven
 * without a cluster (see that section's correction note).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ActorContext } from '../src/domain/actor.js';
import { config } from '../src/config/index.js';
import { db } from '../src/db/knex.js';
import * as catalogService from '../src/services/catalog.service.js';
import * as dashboardService from '../src/services/dashboard.service.js';
import * as inventoryService from '../src/services/inventory.service.js';
import * as leadService from '../src/services/lead.service.js';
import * as orderService from '../src/services/order.service.js';
import * as snapshotService from '../src/services/snapshot.service.js';
import * as syncRepo from '../src/repositories/sync.repository.js';
import { canRunIntegrationTests } from './helpers/db.js';
import { actorWith, resetData, setupDatabase, stageIdByName, teardownDatabase, testActor, testTenantId } from './helpers/fixtures.js';

let actor: ActorContext;

async function createLead(): Promise<{ leadId: string; partyId: string; productId: string }> {
  const party = await catalogService.createParty({ name: `DSH Party ${Date.now()}-${Math.random()}` }, actor);
  const product = await catalogService.createProduct(
    {
      // Sub-product names are unique inside their product (catalogue v2).
      name: `DSH Tile ${Math.random().toString(36).slice(2, 8)}`,
      categoryName: 'Tiles',
      variants: [{ code: `DSH-${Math.random().toString(36).slice(2, 8)}` }],
    },
    actor,
  );
  const variantId = product.variants[0]!.id;
  await inventoryService.recordInbound({ variantId, quantityBoxes: 100 }, actor);

  const lead = await leadService.createLead(
    {
      partyId: party.id,
      items: [{ productId: product.id, variantId, quantity: 10, packaging: 'Box' }],
    },
    actor,
  );
  return { leadId: lead.id, partyId: party.id, productId: product.id };
}

async function createDispatchedOrder(): Promise<{ orderId: string }> {
  const { leadId } = await createLead();
  const order = await orderService.convertLead({ leadId }, actor);
  await orderService.dispatchOrder({ orderId: order.id }, actor);
  return { orderId: order.id };
}

describe.skipIf(!canRunIntegrationTests)('Dashboard (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);

  beforeEach(async () => {
    await resetData();
    actor = await testActor();
  });

  it('DSH-4: omits leadCount, followUpsDueCount and pipelineBreakdown entirely for an actor without leads.view', async () => {
    const limited = await actorWith(['orders.view']);
    const summary = await dashboardService.getDashboardSummary(limited);

    expect('leadCount' in summary).toBe(false);
    expect('followUpsDueCount' in summary).toBe(false);
    expect('pipelineBreakdown' in summary).toBe(false);
    expect(summary.asOf).toBeTruthy();
  });

  it('DSH-5: dispatchedThisWeekCount uses config.locale.timeZone and does not shift a Monday 00:30 IST dispatch into the previous week', async () => {
    const tz = config.locale.timeZone;
    const { rows } = await db().raw<{ rows: Array<{ week_start: string }> }>(
      `SELECT (date_trunc('week', now() AT TIME ZONE ?) AT TIME ZONE ?) AS week_start`,
      [tz, tz],
    );
    const weekStartUtc = new Date(rows[0]!.week_start);
    // 30 minutes after this week's Monday 00:00 IST — must count.
    const insideIso = new Date(weekStartUtc.getTime() + 30 * 60 * 1000).toISOString();
    // 5 minutes before it, i.e. Sunday 23:55 IST of the previous week — must not.
    const outsideIso = new Date(weekStartUtc.getTime() - 5 * 60 * 1000).toISOString();

    const { orderId: insideId } = await createDispatchedOrder();
    await db()('orders').where({ id: insideId }).update({ dispatched_at: insideIso });

    const { orderId: outsideId } = await createDispatchedOrder();
    await db()('orders').where({ id: outsideId }).update({ dispatched_at: outsideIso });

    const summary = await dashboardService.getDashboardSummary(actor);
    expect(summary.dispatchedThisWeekCount).toBe(1);
  });

  it('DSH-10: convertedTodayCount and dispatchedTodayCount count from local midnight, not UTC midnight', async () => {
    const tz = config.locale.timeZone;
    const { rows } = await db().raw<{ rows: Array<{ day_start: string }> }>(
      `SELECT (date_trunc('day', now() AT TIME ZONE ?) AT TIME ZONE ?) AS day_start`,
      [tz, tz],
    );
    const dayStartUtc = new Date(rows[0]!.day_start);
    // 30 minutes after today's 00:00 IST — must count.
    const insideIso = new Date(dayStartUtc.getTime() + 30 * 60 * 1000).toISOString();
    // 23:55 IST yesterday — must not.
    const outsideIso = new Date(dayStartUtc.getTime() - 5 * 60 * 1000).toISOString();

    const { orderId: insideId } = await createDispatchedOrder();
    await db()('orders').where({ id: insideId }).update({ created_at: insideIso, dispatched_at: insideIso });

    const { orderId: outsideId } = await createDispatchedOrder();
    await db()('orders').where({ id: outsideId }).update({ created_at: outsideIso, dispatched_at: outsideIso });

    // Converted today but not dispatched yet.
    const { leadId } = await createLead();
    const open = await orderService.convertLead({ leadId }, actor);
    await db()('orders').where({ id: open.id }).update({ created_at: insideIso });

    const summary = await dashboardService.getDashboardSummary(actor);
    expect(summary.convertedTodayCount).toBe(2);
    expect(summary.dispatchedTodayCount).toBe(1);

    // Counts are an orders.view figure: absent, not 0, without it.
    const without = await actorWith(['leads.view']);
    const hidden = await dashboardService.getDashboardSummary(without);
    expect('convertedTodayCount' in hidden).toBe(false);
    expect('dispatchedTodayCount' in hidden).toBe(false);
  });

  it('DSH-6: pipeline breakdown excludes converted leads and names stages from pipeline_stages', async () => {
    const newStageId = await stageIdByName('lead', 'New');

    await createLead();
    const converted = await createLead();
    await orderService.convertLead({ leadId: converted.leadId }, actor);

    const summary = await dashboardService.getDashboardSummary(actor);
    const newStage = summary.pipelineBreakdown?.find((stage) => stage.stageId === newStageId);

    expect(newStage).toBeDefined();
    expect(newStage?.stageName).toBe('New');
    // Two leads created in this stage, one converted away — only the open one counts.
    expect(newStage?.leadCount).toBe(1);
  });

  it('DSH-7: buildSnapshot still succeeds for an actor missing several module permissions', async () => {
    const limited = await actorWith(['leads.view']);

    const snapshot = await snapshotService.buildSnapshot(limited);

    expect(snapshot.dashboard.leadCount).toBeDefined();
    expect('orderCount' in snapshot.dashboard).toBe(false);
    expect('partyCount' in snapshot.dashboard).toBe(false);
    expect('productCount' in snapshot.dashboard).toBe(false);
    expect('lowStockCount' in snapshot.dashboard).toBe(false);
    expect('openConflictCount' in snapshot.dashboard).toBe(false);
    // The rest of the snapshot must not have become all-or-nothing either.
    expect(Array.isArray(snapshot.parties)).toBe(true);
    expect(Array.isArray(snapshot.orders)).toBe(true);
  });

  it('DSH-8: SyncSnapshot.dashboard equals what dashboard:get (getDashboardSummary) returns for the same actor', async () => {
    await createLead();

    const [snapshot, direct] = await Promise.all([
      snapshotService.buildSnapshot(actor),
      dashboardService.getDashboardSummary(actor),
    ]);

    const { asOf: _snapshotAsOf, ...snapshotFigures } = snapshot.dashboard;
    const { asOf: _directAsOf, ...directFigures } = direct;
    expect(snapshotFigures).toEqual(directFigures);
  });

  it('DSH-9: openConflictCount and pendingSyncCount are present for a sync.resolveConflicts holder and absent (not 0) for everyone else', async () => {
    const tenantId = await testTenantId();

    await db().transaction(async (trx) => {
      await syncRepo.recordConflicts(
        [
          {
            tenantId,
            entity: 'lead',
            entityId: 'LD_DSH_9',
            field: 'notes',
            losingValue: 'a',
            losingHlc: '0000000000001-00000-DEVICEA',
            losingDeviceCode: 'DEVICEA',
            winningValue: 'b',
            winningHlc: '0000000000002-00000-DEVICEB',
            winningDeviceCode: 'DEVICEB',
          },
        ],
        trx,
      );
      await syncRepo.recordAppliedMutation(
        { tenantId, mutationId: 'MUT_DSH_9', entity: 'lead', entityId: 'LD_DSH_9' },
        { mutationId: 'MUT_DSH_9', status: 'applied', entityId: 'LD_DSH_9', conflicts: [] },
        trx,
      );
    });

    const holder = actor;
    const withSync = await dashboardService.getDashboardSummary(holder);
    expect(withSync.openConflictCount).toBeGreaterThanOrEqual(1);
    expect(withSync.pendingSyncCount).toBeGreaterThanOrEqual(1);

    const without = await actorWith(['leads.view']);
    const summary = await dashboardService.getDashboardSummary(without);
    expect('openConflictCount' in summary).toBe(false);
    expect('pendingSyncCount' in summary).toBe(false);
  });
});
