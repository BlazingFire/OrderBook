/**
 * `docs/backend-modules/10-TESTING.md` §6.8, `DSH-1`/`DSH-2`. Pure — drives
 * `GET /api/snapshot` through `createApp()` with `localStore.getView` and the
 * signed-in session mocked, in the `module-forwarding.test.ts` style, so no
 * cluster is needed and the suite cannot silently skip.
 *
 * `DSH-1`: the fixture below is typed `SyncSnapshot` (compiles only when
 * every key is present, per `office/src/http/app.ts`'s `SNAPSHOT_POLICY`
 * being `Record<keyof SyncSnapshot, SnapshotPolicy>`), and `forCurrentUser`
 * must hand back exactly that key set.
 *
 * `DSH-2`: every `mask-rates` key loses its gated field by absence, not by
 * `null`, for a session without `field.saleRate.view`.
 */

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncSnapshot } from '@orderbook/shared';

import { createApp } from '../src/http/app.js';
import * as localStore from '../src/sync/local-store.js';
import * as userSession from '../src/services/user-session.service.js';

const NOW = '2026-08-01T00:00:00.000Z';

const SYNC_META = { version: 1, hlc: 'h1', fieldHlc: {}, temporaryId: null };

const FIXTURE: SyncSnapshot = {
  parties: [
    {
      id: 'PT0000000001',
      tenantId: 't1',
      partyCode: 'P-0001',
      name: 'Patel Tiles',
      phone: null,
      altPhone: null,
      email: null,
      addressLine1: null,
      addressLine2: null,
      city: null,
      state: null,
      pincode: null,
      gstNumber: null,
      notes: null,
      customFields: {},
      isActive: true,
      createdByUserId: null,
      createdAt: NOW,
      updatedAt: NOW,
      sync: SYNC_META,
    },
  ],
  products: [
    {
      id: 'PR0000000001',
      tenantId: 't1',
      name: 'Ivory Basin',
      alias: null,
      categoryId: 'PC0000000001',
      categoryName: 'Basins',
      size: null,
      sin: null,
      grade: null,
      productType: null,
      hasVariants: false,
      variants: [
        {
          id: 'VR0000000001',
          productId: 'PR0000000001',
          code: 'C-100',
          label: null,
          weightKg: null,
          sequence: 1,
          isActive: true,
        },
      ],
      finish: null,
      series: null,
      thicknessMm: null,
      piecesPerBox: null,
      boxCoverageSqft: null,
      rate: 1250,
      pricePerSqft: 50,
      hsnCode: null,
      mrp: 1500,
      // Present in the fixture on purpose: this suite exists to prove what
      // *leaves* the panel, and a field that is never set cannot be shown to
      // have been withheld.
      purchaseRate: 900,
      gstRatePct: 18,
      uom: 'box',
      barcode: null,
      brand: null,
      shade: null,
      calibre: null,
      waterAbsorptionPct: null,
      peiRating: null,
      edgeType: null,
      surfaceTexture: null,
      application: null,
      originPlant: null,
      parameters: {},
      customFields: {},
      isActive: true,
      createdAt: NOW,
      updatedAt: NOW,
      sync: SYNC_META,
      images: [],
    },
  ],
  categories: [{ id: 'CT0000000001', tenantId: 't1', name: 'Basins', createdAt: NOW }],
  partyVariants: [
    {
      id: 'PV0000000001',
      tenantId: 't1',
      partyId: 'PT0000000001',
      productId: 'PR0000000001',
      productName: 'Ivory Basin',
      alias: null,
      rate: 1100,
      size: null,
      sin: null,
      grade: null,
      productType: null,
      weightKg: null,
      packaging: null,
      createdAt: NOW,
      updatedAt: NOW,
      sync: SYNC_META,
    },
  ],
  leads: [
    {
      id: 'LD0000000001',
      tenantId: 't1',
      partyId: 'PT0000000001',
      partyName: 'Patel Tiles',
      ownerId: 'u1',
      ownerName: null,
      stageId: 's1',
      stageName: 'New',
      stageSequence: 1,
      sourcePlatform: null,
      followUpDate: null,
      partyWiseMode: false,
      notes: null,
      customFields: {},
      incomplete: false,
      missingFields: [],
      convertedOrderId: null,
      convertedAt: null,
      totalAmount: 2500,
      totalWeightKg: 0,
      linesWithoutWeight: 0,
      sourcePanelId: null,
      createdByUserId: null,
      createdAt: NOW,
      updatedAt: NOW,
      sync: SYNC_META,
      items: [],
      timeline: [],
    },
  ],
  orders: [
    {
      id: 'OR0000000001',
      tenantId: 't1',
      leadId: null,
      partyId: 'PT0000000001',
      partyName: 'Patel Tiles',
      ownerId: 'u1',
      ownerName: null,
      stageId: 's1',
      stageName: 'Booked',
      stageSequence: 1,
      dispatchAddressLabel: null,
      expectedDispatchDate: null,
      totalWeightKg: 0,
      totalWeightKgOverride: null,
      weightSource: 'computed',
      notes: null,
      customFields: {},
      incomplete: false,
      missingFields: [],
      totalAmount: 4200,
      linesWithoutWeight: 0,
      dispatchedAt: null,
      sourcePanelId: null,
      createdByUserId: null,
      createdAt: NOW,
      updatedAt: NOW,
      sync: SYNC_META,
      items: [],
      timeline: [],
      reservations: [],
    },
  ],
  stock: [
    {
      productId: 'PR0000000001',
      productName: 'Ivory Basin',
      categoryName: 'Basins',
      size: null,
      variantId: 'VR0000000001',
      variantCode: 'C-100',
      variantLabel: null,
      weightKg: null,
      quantityBoxes: 10,
      reservedBoxes: 2,
      availableBoxes: 8,
      quantitySqft: 100,
      minStockLevel: null,
      maxStockLevel: null,
      reorderLevel: 5,
      isLow: false,
      updatedAt: NOW,
    },
  ],
  pipelines: [
    {
      id: 'p1',
      tenantId: 't1',
      kind: 'lead',
      name: 'Lead pipeline',
      stages: [
        {
          id: 's1',
          pipelineId: 'p1',
          name: 'New',
          sequence: 1,
          isDefault: true,
          isTerminal: false,
          colour: null,
          isArchived: false,
        },
      ],
    },
  ],
  optionLists: [
    {
      id: 'OL0000000001',
      tenantId: 't1',
      listKey: 'lead.sourcePlatform',
      value: 'whatsapp',
      label: 'WhatsApp',
      sequence: 1,
      isActive: true,
      hex: null,
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
      version: 1,
    },
  ],
  customFields: [
    {
      id: 'CF0000000001',
      tenantId: 't1',
      entity: 'lead',
      key: 'referral',
      label: 'Referral',
      fieldType: 'text',
      isRequired: false,
      options: [],
      sequence: 1,
      isActive: true,
      deletedAt: null,
      version: 1,
    },
  ],
  conflicts: [],
  dashboard: { leadCount: 3, asOf: NOW },
  permissions: ['leads.create'],
  serverHlc: '0000001700000000000-00000-MASTER',
  serverTime: NOW,
};

const FAKE_SESSION = {
  userId: 'US0000000001',
  username: 'kiran',
  displayName: 'Kiran',
  roleId: 'RL0000000001',
  roleName: 'Sales',
  roleTier: 'office',
  permissions: ['leads.create'],
  offline: false,
  signedInAt: NOW,
};

describe('snapshot masking (DSH-1, DSH-2)', () => {
  beforeEach(() => {
    vi.spyOn(userSession, 'currentSession').mockReturnValue(FAKE_SESSION as never);
    vi.spyOn(localStore, 'getView').mockResolvedValue({ ...FIXTURE, pendingCount: 0 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns exactly the keys an exhaustive SyncSnapshot carries, plus pendingCount', async () => {
    vi.spyOn(userSession, 'sessionPermissions').mockReturnValue(['leads.create']);

    const response = await request(createApp()).get('/api/snapshot');

    expect(response.status).toBe(200);
    const expectedKeys = [...Object.keys(FIXTURE), 'pendingCount'].sort();
    expect(Object.keys(response.body).sort()).toEqual(expectedKeys);
  });

  it('deletes rate fields for a session without field.saleRate.view, rather than nulling them', async () => {
    vi.spyOn(userSession, 'sessionPermissions').mockReturnValue(['leads.create']);

    const response = await request(createApp()).get('/api/snapshot');

    expect(response.status).toBe(200);
    expect('rate' in response.body.products[0]).toBe(false);
    expect('pricePerSqft' in response.body.products[0]).toBe(false);
    expect('rate' in response.body.partyVariants[0]).toBe(false);
    expect('totalAmount' in response.body.leads[0]).toBe(false);
    expect('totalAmount' in response.body.orders[0]).toBe(false);
  });

  it('keeps rate fields for a session with field.saleRate.view', async () => {
    vi.spyOn(userSession, 'sessionPermissions').mockReturnValue([
      'leads.create',
      'field.saleRate.view',
    ]);

    const response = await request(createApp()).get('/api/snapshot');

    expect(response.status).toBe(200);
    expect(response.body.products[0].rate).toBe(1250);
    expect(response.body.leads[0].totalAmount).toBe(2500);
  });

  /**
   * The two prices are separate secrets with separate audiences: a sales desk
   * quotes the sale rate all day and must never see the margin. They used to be
   * one boolean, which is how the purchase rate reached everybody holding
   * `field.saleRate.view`.
   */
  it('withholds the purchase rate from a session that may only see the sale rate', async () => {
    vi.spyOn(userSession, 'sessionPermissions').mockReturnValue([
      'leads.create',
      'field.saleRate.view',
    ]);

    const response = await request(createApp()).get('/api/snapshot');

    expect(response.status).toBe(200);
    expect(response.body.products[0].rate).toBe(1250);
    expect('purchaseRate' in response.body.products[0]).toBe(false);
    // Printed on the box; hiding it would be theatre.
    expect(response.body.products[0].mrp).toBe(1500);
  });

  it('keeps the purchase rate for a session that holds its own key', async () => {
    vi.spyOn(userSession, 'sessionPermissions').mockReturnValue([
      'leads.create',
      'field.saleRate.view',
      'field.purchaseRate.view',
    ]);

    const response = await request(createApp()).get('/api/snapshot');

    expect(response.status).toBe(200);
    expect(response.body.products[0].purchaseRate).toBe(900);
  });

  /**
   * Only reachable offline — an online sign-in re-fetches the snapshot for the
   * new person. Offline there is nobody to ask, so a cached snapshot scoped for
   * one person has to stop being trusted the moment somebody else signs in on
   * that panel, or a second sign-in is the easiest bypass of Party Access there
   * is.
   */
  describe('a snapshot scoped for somebody else', () => {
    const RESTRICTED = {
      ...FIXTURE,
      builtForUserId: 'US0000000001',
      partyGrants: [{ partyId: 'PT0000000001', level: 'manage' as const }],
    };

    it('withholds the previous person’s restricted parties and their records', async () => {
      vi.spyOn(localStore, 'getView').mockResolvedValue({ ...RESTRICTED, pendingCount: 0 });
      vi.spyOn(userSession, 'currentSession').mockReturnValue({
        ...FAKE_SESSION,
        userId: 'US0000000002',
      } as never);
      vi.spyOn(userSession, 'sessionPermissions').mockReturnValue(['leads.create']);

      const response = await request(createApp()).get('/api/snapshot');

      expect(response.status).toBe(200);
      expect(response.body.parties).toHaveLength(0);
      expect(response.body.leads).toHaveLength(0);
      expect(response.body.orders).toHaveLength(0);
      expect(response.body.partyVariants).toHaveLength(0);
      expect(response.body.partyGrants).toEqual([]);
    });

    it('keeps everything for the person it was built for', async () => {
      vi.spyOn(localStore, 'getView').mockResolvedValue({ ...RESTRICTED, pendingCount: 0 });
      vi.spyOn(userSession, 'sessionPermissions').mockReturnValue(['leads.create']);

      const response = await request(createApp()).get('/api/snapshot');

      expect(response.status).toBe(200);
      expect(response.body.parties).toHaveLength(1);
      expect(response.body.leads).toHaveLength(1);
    });

    it('leaves an older Master’s snapshot alone — it has no restricted parties in it', async () => {
      vi.spyOn(userSession, 'currentSession').mockReturnValue({
        ...FAKE_SESSION,
        userId: 'US0000000002',
      } as never);
      vi.spyOn(userSession, 'sessionPermissions').mockReturnValue(['leads.create']);

      // `FIXTURE` carries no `builtForUserId` — exactly what a Master built
      // before this feature existed sends.
      const response = await request(createApp()).get('/api/snapshot');

      expect(response.status).toBe(200);
      expect(response.body.parties).toHaveLength(1);
    });
  });
});
