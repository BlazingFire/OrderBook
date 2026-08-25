/**
 * `docs/backend-modules/10-TESTING.md` §6.8, `DSH-3`. Pure — mirrors
 * `snapshot-masking.test.ts`'s harness.
 *
 * Covers the half of `DSH-3` that is backend-testable without a browser: the
 * cached snapshot on disk was built for whoever was signed in when the link
 * last worked, and `forCurrentUser` must strip a `dashboard` figure the
 * *current* session does not hold rather than trusting the cached value.
 *
 * `DSH-3`'s other half — "a disconnected panel labels every card stale
 * except the sync card" — is a client-side rendering rule keyed off
 * `dashboard.asOf`. No Office Dashboard screen exists yet
 * (`docs/backend-modules/11-BUILD-SEQUENCE.md` Stage 8 covers only the API
 * surface: `master/src`, Office forwarding, and the `office/web/src/api.ts`
 * wrapper), so that half has nothing to drive yet and is left for the
 * frontend build that consumes `refreshDashboard`/`dashboard:changed`.
 */

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncSnapshot } from '@orderbook/shared';

import { createApp } from '../src/http/app.js';
import * as localStore from '../src/sync/local-store.js';
import * as userSession from '../src/services/user-session.service.js';

const NOW = '2026-08-01T00:00:00.000Z';

const BASE_SNAPSHOT: Omit<SyncSnapshot, 'dashboard' | 'permissions'> = {
  parties: [],
  products: [],
  categories: [],
  partyVariants: [],
  leads: [],
  orders: [],
  stock: [],
  pipelines: [],
  optionLists: [],
  customFields: [],
  conflicts: [],
  serverHlc: '0000001700000000000-00000-MASTER',
  serverTime: NOW,
};

// Cached while a fully-permissioned manager was last signed in — every
// figure the Master could compute for them is present.
const DASHBOARD_FOR_MANAGER = {
  leadCount: 12,
  orderCount: 4,
  partyCount: 30,
  productCount: 120,
  lowStockCount: 2,
  followUpsDueCount: 5,
  openConflictCount: 1,
  pendingSyncCount: 0,
  openOrderCount: 3,
  dispatchedThisWeekCount: 6,
  pipelineBreakdown: [{ stageId: 's1', stageName: 'New', sequence: 1, colourHex: null, leadCount: 12 }],
  asOf: NOW,
};

const SALES_SESSION = {
  userId: 'US0000000002',
  username: 'asha',
  displayName: 'Asha',
  roleId: 'RL0000000002',
  roleName: 'Sales',
  roleTier: 'office',
  permissions: ['leads.view'],
  offline: false,
  signedInAt: NOW,
};

describe('dashboard staleness — permission stripping (DSH-3)', () => {
  beforeEach(() => {
    vi.spyOn(userSession, 'currentSession').mockReturnValue(SALES_SESSION as never);
    vi.spyOn(userSession, 'sessionPermissions').mockReturnValue(['leads.view']);
    vi.spyOn(localStore, 'getView').mockResolvedValue({
      ...BASE_SNAPSHOT,
      dashboard: DASHBOARD_FOR_MANAGER,
      permissions: ['leads.view', 'orders.view', 'parties.view', 'products.view', 'inventory.view', 'sync.resolveConflicts'],
      pendingCount: 0,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('strips every figure the current session does not hold, keeping only leads.view figures', async () => {
    const response = await request(createApp()).get('/api/snapshot');

    expect(response.status).toBe(200);
    const dashboard = response.body.dashboard;

    expect(dashboard.leadCount).toBe(12);
    expect(dashboard.followUpsDueCount).toBe(5);
    expect(dashboard.pipelineBreakdown).toEqual(DASHBOARD_FOR_MANAGER.pipelineBreakdown);
    expect(dashboard.asOf).toBe(NOW);

    for (const key of ['orderCount', 'partyCount', 'productCount', 'lowStockCount', 'openConflictCount', 'pendingSyncCount', 'openOrderCount', 'dispatchedThisWeekCount']) {
      expect(key in dashboard).toBe(false);
    }
  });

  it('replaces the cached permissions list with the current session\'s own', async () => {
    const response = await request(createApp()).get('/api/snapshot');

    expect(response.body.permissions).toEqual(['leads.view']);
  });
});
