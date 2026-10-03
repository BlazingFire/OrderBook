/**
 * The sample-data seed against a real database: it produces what the dataset
 * says it does, through the real services, with a history that reads as one
 * (timestamps in the past, in order, and an audit chain that still verifies)
 * — and it refuses to run twice.
 *
 * Seeded once for the whole file: a seed is three hundred service calls and
 * as many backdating transactions, some fifteen seconds, and every test here
 * reads the same result. Photos are skipped: the image pipeline has its own
 * suites, and rasterising twenty-odd swatches would add most of a minute for
 * nothing this file is about. `tile-swatch.test.ts` covers the drawing.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SeedSampleDataResult } from '@orderbook/shared';

import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testTenantId } from './helpers/fixtures.js';
import { db } from '../src/db/knex.js';
import {
  SAMPLE_DELETIONS,
  SAMPLE_LEADS,
  SAMPLE_OPTION_VALUES,
  SAMPLE_PARTIES,
  SAMPLE_WINDOW_DAYS,
} from '../src/domain/sample-data.js';
import { chainBounds, verifyChain } from '../src/repositories/activity-log.repository.js';
import * as auth from '../src/services/auth.service.js';
import * as catalog from '../src/services/catalog.service.js';
import { getDashboardSummary } from '../src/services/dashboard.service.js';
import { seedSampleData } from '../src/services/sample-data.service.js';
import { isSetupComplete } from '../src/services/setup.service.js';
import { permissionSetForRole } from '../src/repositories/role.repository.js';

const NOW = new Date('2026-09-18T12:00:00.000Z');

const wonLeads = SAMPLE_LEADS.filter((lead) => lead.outcome.kind === 'won');
const dispatchedLeads = wonLeads.filter(
  (lead) => lead.outcome.kind === 'won' && lead.outcome.order.kind === 'dispatched',
);

describe.skipIf(!canRunIntegrationTests)('sample data seed (integration)', () => {
  let result: SeedSampleDataResult;

  beforeAll(async () => {
    await setupDatabase();
    await resetData();
    result = await seedSampleData({ now: NOW, images: false });
  }, 120_000);
  afterAll(teardownDatabase);

  it('seeds the users, the catalogue, six months of leads and orders, and reports what it made', async () => {
    // A blank Master: the seed set it up itself with the two test Server
    // Masters (1.3 creates no admin at first run), then made the three sign-ins.
    expect(await isSetupComplete()).toBe(true);
    expect(result.pairingPassword).toMatch(/^[A-Z2-9]{10}$/);
    expect(result.users.map((user) => user.username)).toEqual([
      'master',
      'master-backup',
      'admin',
      'management',
      'office',
    ]);

    expect(result.counts).toMatchObject({
      parties: SAMPLE_PARTIES.length,
      // The product master is the whole SWISWARE catalogue file, loaded on
      // day one: 549 sub products (`docs/catalogue/CATALOGUE_MODEL.md` §4).
      products: 549,
      images: 0,
      leads: SAMPLE_LEADS.length,
      orders: wonLeads.length,
      dispatched: dispatchedLeads.length,
      deleted: 3,
      optionValues: Object.values(SAMPLE_OPTION_VALUES).reduce((n, list) => n + list.length, 0),
    });
    expect(result.from < result.to).toBe(true);
    expect(result.to).toBe('2026-09-18');

    const tenantId = await testTenantId();

    // Every stage of both pipelines has something on it.
    const leadStages = await db()('leads')
      .join('pipeline_stages', 'pipeline_stages.id', 'leads.stage_id')
      .where({ 'leads.tenant_id': tenantId })
      .whereNull('leads.deleted_at')
      .groupBy('pipeline_stages.name')
      .select<Array<{ name: string; count: string }>>('pipeline_stages.name')
      .count('* as count');
    expect(leadStages.map((row) => row.name).sort()).toEqual([
      'Lost',
      'Negotiating',
      'New',
      'Quoted',
      'Won',
    ]);

    const orderStages = await db()('orders')
      .join('pipeline_stages', 'pipeline_stages.id', 'orders.stage_id')
      .where({ 'orders.tenant_id': tenantId })
      .groupBy('pipeline_stages.name')
      .select<Array<{ name: string }>>('pipeline_stages.name');
    expect(orderStages.map((row) => row.name).sort()).toEqual([
      'Cancelled',
      'Dispatched',
      'In Progress',
      'Postpone',
    ]);

    // The Recycle Bin has one of each.
    expect(
      await db()('parties')
        .where({ tenant_id: tenantId })
        .whereNotNull('deleted_at')
        .count('* as n')
        .first(),
    ).toMatchObject({ n: '1' });
    expect(
      await db()('products')
        .where({ tenant_id: tenantId })
        .whereNotNull('deleted_at')
        .count('* as n')
        .first(),
    ).toMatchObject({ n: '1' });
    expect(
      await db()('leads')
        .where({ tenant_id: tenantId })
        .whereNotNull('deleted_at')
        .count('* as n')
        .first(),
    ).toMatchObject({ n: '1' });
    const binnedProduct = await db()('products as p')
      .join('product_variants as v', 'v.product_id', 'p.id')
      .where({ 'p.tenant_id': tenantId, 'v.code': SAMPLE_DELETIONS.productCode })
      .first<{ deleted_at: Date | null }>('p.deleted_at');
    expect(binnedProduct?.deleted_at).not.toBeNull();
  });

  it('writes the history into the past, in order, without breaking the audit chain', async () => {
    const tenantId = await testTenantId();

    // Nothing is stamped "now": the oldest lead is months old and the newest
    // record is no later than the pinned clock.
    const leadSpan = await db()('leads')
      .where({ tenant_id: tenantId })
      .first<{ oldest: Date; newest: Date }>(
        db().raw('min(created_at) as oldest'),
        db().raw('max(created_at) as newest'),
      );
    const daysBack = (NOW.getTime() - leadSpan!.oldest.getTime()) / 86_400_000;
    expect(daysBack).toBeGreaterThan(SAMPLE_WINDOW_DAYS - 20);
    expect(daysBack).toBeLessThan(SAMPLE_WINDOW_DAYS);
    expect(leadSpan!.newest.getTime()).toBeLessThanOrEqual(NOW.getTime());

    // Dispatches spread across months, which is what the reports bucket by.
    const months = await db()('orders')
      .where({ tenant_id: tenantId })
      .whereNotNull('dispatched_at')
      .distinct(db().raw("to_char(dispatched_at, 'YYYY-MM') as month"));
    expect(months.length).toBeGreaterThanOrEqual(4);

    // ...and one of them is today, so "dispatched this week" has a figure
    // whatever weekday the seed ran on.
    const latest = await db()('orders')
      .where({ tenant_id: tenantId })
      .first<{ at: Date | null }>(db().raw('max(dispatched_at) as at'));
    expect(NOW.getTime() - latest!.at!.getTime()).toBeLessThan(86_400_000);

    // The log is paginated by id and rendered by created_at; the seed ran its
    // events in date order precisely so the two never disagree.
    const log = await db()('activity_log')
      .where({ tenant_id: tenantId })
      .orderBy('id', 'asc')
      .select<Array<{ created_at: Date }>>('created_at');
    expect(log.length).toBeGreaterThan(100);
    for (let i = 1; i < log.length; i += 1) {
      expect(log[i]!.created_at.getTime()).toBeGreaterThanOrEqual(log[i - 1]!.created_at.getTime());
    }
    expect(log.at(-1)!.created_at.getTime()).toBeLessThanOrEqual(NOW.getTime());

    // Backdating touched `created_at` only, which the hash does not cover.
    const bounds = await chainBounds(tenantId);
    const verification = await verifyChain(tenantId, {
      fromSequence: bounds.minSequence!,
      toSequence: bounds.maxSequence!,
    });
    expect(verification.ok).toBe(true);
    expect(verification.checkedCount).toBeGreaterThan(100);
  });

  it('leaves a ledger the dashboard can read: orders, open orders and due follow-ups', async () => {
    const tenantId = await testTenantId();

    const adminRole = await db()('roles')
      .where({ tenant_id: tenantId, tier: 'admin' })
      .first<{ id: string }>('id');
    const admin = {
      tenantId,
      actorType: 'user' as const,
      actorId: null,
      userId: null,
      permissions: await permissionSetForRole(tenantId, adminRole!.id),
      deviceCode: null,
      actorName: 'Admin',
    };
    const summary = await getDashboardSummary(admin);
    expect(summary.leadCount).toBeGreaterThan(0);
    expect(summary.orderCount).toBe(wonLeads.length);
    expect(summary.followUpsDueCount).toBeGreaterThanOrEqual(3);
    expect(summary.openOrderCount).toBeGreaterThan(0);
    expect(summary.pipelineBreakdown?.some((stage) => stage.leadCount > 0)).toBe(true);
  });

  it('applies party access: the office user cannot see the party restricted to management', async () => {
    const tenantId = await testTenantId();

    const office = await auth.signIn('office', 'Office@1234');
    const officeRole = await db()('roles')
      .where({ tenant_id: tenantId, tier: 'office' })
      .first<{ id: string }>('id');
    const actor = {
      tenantId,
      actorType: 'user' as const,
      actorId: office.user.id,
      userId: office.user.id,
      permissions: await permissionSetForRole(tenantId, officeRole!.id),
      deviceCode: null,
      actorName: 'Office',
    };

    const visible = await catalog.listParties({ limit: 100, offset: 0 }, actor);
    const names = visible.items.map((party) => party.name);
    expect(names).toContain('Patel Ceramic Traders');
    expect(names).toContain('Shree Ganesh Tiles & Sanitary');
    expect(names).not.toContain('Mehta Constructions');
  });

  it('refuses to run a second time on the same Master, without touching the users', async () => {
    // A refused press must not re-arm anybody: the session opened before it
    // is still good afterwards.
    const before = await auth.signIn('admin', 'Admin@1234');

    await expect(seedSampleData({ now: NOW, images: false })).rejects.toMatchObject({
      messageKey: 'validation.developer.sampleDataPresent',
    });

    expect(await auth.resolveSession(before.token)).not.toBeNull();
  });
});
