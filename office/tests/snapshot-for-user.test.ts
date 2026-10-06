/**
 * `docs/backend-modules/10-TESTING.md` §6.8, `DSH-1`. Pure — drives
 * `GET /api/snapshot` through `createApp()` with `localStore.getView` and the
 * signed-in session mocked, in the `module-forwarding.test.ts` style, so no
 * cluster is needed and the suite cannot silently skip.
 *
 * `DSH-1`: the fixture below is typed `SyncSnapshot` (compiles only when
 * every key is present, per `office/src/http/app.ts`'s `SNAPSHOT_POLICY`
 * being `Record<keyof SyncSnapshot, SnapshotPolicy>`), and `forCurrentUser`
 * must hand back exactly that key set — with the permissions replaced by the
 * session's own and the dashboard gated for it.
 */

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncSnapshot } from '@orderbook/shared';

import { createApp, SNAPSHOT_POLICY } from '../src/http/app.js';
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
      categoryCode: null,
      brand: null,
      sortOrder: null,
      size: null,
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
      multiColour: false,
      customFields: {},
      isActive: true,
      createdAt: NOW,
      updatedAt: NOW,
      sync: SYNC_META,
      images: [],
    },
  ],
  categories: [
    {
      id: 'CT0000000001',
      tenantId: 't1',
      name: 'Basins',
      code: null,
      brand: null,
      sortOrder: null,
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
    },
  ],
  partyVariants: [
    {
      id: 'PV0000000001',
      tenantId: 't1',
      partyId: 'PT0000000001',
      productId: 'PR0000000001',
      productName: 'Ivory Basin',
      alias: null,
      size: null,
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
      linesWithoutWeight: 0,
      dispatchedAt: null,
      sourcePanelId: null,
      createdByUserId: null,
      createdAt: NOW,
      updatedAt: NOW,
      sync: SYNC_META,
      items: [],
      timeline: [],
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
  protocol: 2,
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

describe('snapshot for the current user (DSH-1)', () => {
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

  it("passes the Master's protocol through untouched (it is the same for every reader)", async () => {
    vi.spyOn(userSession, 'sessionPermissions').mockReturnValue(['leads.create']);

    expect(SNAPSHOT_POLICY.protocol).toBe('passthrough');

    const response = await request(createApp()).get('/api/snapshot');

    expect(response.status).toBe(200);
    expect(response.body.protocol).toBe(2);
  });

  it("replaces the cached permissions with the session's own", async () => {
    vi.spyOn(userSession, 'sessionPermissions').mockReturnValue(['leads.create', 'orders.view']);

    const response = await request(createApp()).get('/api/snapshot');

    expect(response.status).toBe(200);
    expect(response.body.permissions).toEqual(['leads.create', 'orders.view']);
    // The records themselves pass through whole — nothing on them is gated per person.
    expect(response.body.products[0].multiColour).toBe(false);
    expect(response.body.partyVariants[0].productName).toBe('Ivory Basin');
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

    describe('built for an administrator, who needs no grant to see a restricted party', () => {
      const asNextPerson = () => {
        vi.spyOn(userSession, 'currentSession').mockReturnValue({
          ...FAKE_SESSION,
          userId: 'US0000000002',
        } as never);
        vi.spyOn(userSession, 'sessionPermissions').mockReturnValue(['leads.create']);
      };

      it('withholds a party the Master did not list as open, though the administrator holds no grant on it', async () => {
        // The administrator's own grants are empty, so the old rule ("not one of their grants,
        // so open") would have shown the next person every restricted party.
        vi.spyOn(localStore, 'getView').mockResolvedValue({
          ...FIXTURE,
          builtForUserId: 'US0000000001',
          partyGrants: [],
          openPartyIds: [],
          pendingCount: 0,
        });
        asNextPerson();

        const response = await request(createApp()).get('/api/snapshot');

        expect(response.body.parties).toHaveLength(0);
        expect(response.body.leads).toHaveLength(0);
        expect(response.body.orders).toHaveLength(0);
        expect(response.body.partyVariants).toHaveLength(0);
      });

      it('withholds a conflict that names a hidden party, lead or order, and keeps one on an open record', async () => {
        const conflict = (id: number, entity: string, entityId: string) =>
          ({
            id,
            entity,
            entityId,
            field: 'name',
            losingValue: 'Secret',
            winningValue: 'Other',
          }) as never;
        const leadId = FIXTURE.leads[0]!.id;
        const withConflicts = {
          ...FIXTURE,
          builtForUserId: 'US0000000001',
          partyGrants: [],
          conflicts: [
            conflict(1, 'party', 'PT0000000001'),
            conflict(2, 'lead', leadId),
            conflict(3, 'product', 'PR0000000001'),
          ],
          pendingCount: 0,
        };
        asNextPerson();

        // Hidden: the party, its lead and the conflicts on them go. A conflict on something that
        // is not party-scoped (a product) stays.
        vi.spyOn(localStore, 'getView').mockResolvedValue({ ...withConflicts, openPartyIds: [] });
        const hidden = await request(createApp()).get('/api/snapshot');
        expect(hidden.body.conflicts.map((c: { id: number }) => c.id)).toEqual([3]);

        // Open: the same conflicts are the next person's to see.
        vi.spyOn(localStore, 'getView').mockResolvedValue({
          ...withConflicts,
          openPartyIds: ['PT0000000001'],
        });
        const open = await request(createApp()).get('/api/snapshot');
        expect(open.body.conflicts.map((c: { id: number }) => c.id)).toEqual([1, 2, 3]);
      });

      it('keeps a creator’s own queued party, which is in nobody’s list, and the lead hanging off it', async () => {
        // A party queued offline has a temporary id and an empty sync.hlc: it is the viewer's own
        // work (the view draws queued work only to its author), not somebody else's restricted party.
        const queuedParty = {
          ...FIXTURE.parties[0]!,
          id: 'TMP000000000001',
          name: 'Own Pending',
          sync: { ...SYNC_META, hlc: '' },
        };
        const queuedLead = { ...FIXTURE.leads[0]!, id: 'TMPLEAD00001', partyId: queuedParty.id };
        vi.spyOn(localStore, 'getView').mockResolvedValue({
          ...FIXTURE,
          parties: [...FIXTURE.parties, queuedParty],
          leads: [...FIXTURE.leads, queuedLead],
          builtForUserId: 'US0000000001',
          partyGrants: [],
          openPartyIds: [],
          pendingCount: 1,
        });
        asNextPerson();

        const response = await request(createApp()).get('/api/snapshot');

        expect(response.body.parties.map((party: { id: string }) => party.id)).toEqual([
          queuedParty.id,
        ]);
        expect(response.body.leads.map((lead: { id: string }) => lead.id)).toEqual([queuedLead.id]);
      });

      it('drops the previous person’s dashboard figures, and the counts of parties it hides', async () => {
        vi.spyOn(localStore, 'getView').mockResolvedValue({
          ...FIXTURE,
          builtForUserId: 'US0000000001',
          partyGrants: [],
          openPartyIds: [],
          partyAccessCounts: { PT0000000001: 2 },
          dashboard: { leadCount: 8, orderCount: 1, partyCount: 13, asOf: NOW },
          pendingCount: 0,
        });
        asNextPerson();
        vi.spyOn(userSession, 'sessionPermissions').mockReturnValue([
          'leads.view',
          'parties.view',
          'orders.view',
        ]);

        const response = await request(createApp()).get('/api/snapshot');

        expect(response.body.dashboard.leadCount).toBeUndefined();
        expect(response.body.dashboard.orderCount).toBeUndefined();
        expect(response.body.dashboard.partyCount).toBeUndefined();
        expect(response.body.partyAccessCounts).toEqual({});
      });

      it('keeps a party the Master listed as open', async () => {
        vi.spyOn(localStore, 'getView').mockResolvedValue({
          ...FIXTURE,
          builtForUserId: 'US0000000001',
          partyGrants: [],
          openPartyIds: ['PT0000000001'],
          pendingCount: 0,
        });
        asNextPerson();

        const response = await request(createApp()).get('/api/snapshot');

        expect(response.body.parties).toHaveLength(1);
        expect(response.body.leads).toHaveLength(1);
      });
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
