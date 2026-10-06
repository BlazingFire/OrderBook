/**
 * Administering one Office Panel from the Master.
 *
 * The sharp edge here is credential rotation, and it is sharp in a way that
 * only shows up on a real network: the Master is replacing the one secret a
 * working panel authenticates with, over a link that is allowed to drop. So the
 * order of operations is load-bearing — the panel must have *taken* the new
 * secret before the Master stops honouring the old one — and the "panel is
 * switched off" case must reissue anyway rather than silently do nothing. Both
 * are pinned below, with a fake panel link standing in for the socket.
 *
 * The rest is the schema working end to end: a device report has to survive a
 * round trip through fifteen new nullable columns without a `null` becoming a
 * `0`, because a disk shown as 0 bytes free is something somebody acts on.
 */

import { UNSCOPED_PARTY_ACCESS } from '../src/domain/party-scope.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { OfficePanelReportInput } from '@orderbook/shared';

import { canRunIntegrationTests } from './helpers/db.js';
import {
  resetData,
  setUpFirstRun,
  setupDatabase,
  teardownDatabase,
  testActor,
  testTenantId,
} from './helpers/fixtures.js';
import { db } from '../src/db/knex.js';
import { setPanelLink, type PanelLink } from '../src/realtime/panel-link.js';
import * as activityLog from '../src/repositories/activity-log.repository.js';
import * as panels from '../src/services/panel.service.js';

/**
 * A stand-in for the hub's socket registry.
 *
 * `answers` decides what a panel "replies", and `refuse` makes it say no —
 * which is how the storage-path refusal path is exercised without a second
 * process on the other end of a socket.
 */
function fakeLink(options: {
  connected: string[];
  answers?: Record<string, unknown>;
  refuse?: string;
}): PanelLink & { sent: Array<{ panelId: string; event: string; payload: unknown }> } {
  const sent: Array<{ panelId: string; event: string; payload: unknown }> = [];

  return {
    sent,
    isConnected: (panelId) => options.connected.includes(panelId),
    request: async <T,>(panelId: string, event: string, payload: unknown): Promise<T> => {
      sent.push({ panelId, event, payload });
      if (options.refuse) throw new Error(options.refuse);
      return (options.answers?.[event] ?? null) as T;
    },
    disconnect: (panelId) => options.connected.includes(panelId),
    notify: (panelId) => options.connected.includes(panelId),
  };
}

const REPORT: OfficePanelReportInput = {
  hostname: 'FRONT-DESK-PC',
  platform: 'win32',
  osVersion: 'Windows_NT 10.0.19045',
  appVersion: '0.1.0',
  nodeVersion: 'v20.11.0',
  dataDir: 'D:\\OrderBook\\panel-data',
  imagesDir: 'D:\\OrderBook\\panel-data\\images',
  storageBytes: 4096,
  diskFreeBytes: 0,
  diskTotalBytes: 512_000_000_000,
  localPort: 4200,
  startedAt: '2026-08-25T08:00:00.000Z',
  pendingMutations: 3,
  cachedImages: 12,
  lastSnapshotAt: '2026-08-25T09:30:00.000Z',
  signedInUsername: 'kiran',
};

describe.skipIf(!canRunIntegrationTests)('office panel administration (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);

  beforeEach(async () => {
    await resetData();
    panels.closePairingWindow();
    await setUpFirstRun('Shree Ceramics');
  });

  afterEach(() => {
    setPanelLink(null);
  });

  async function pairOne(name = 'Front Desk') {
    panels.openPairingWindow();
    return panels.pairPanel({ mode: 'auto', panelName: name, hostname: 'pc1' }, '192.168.1.20');
  }

  describe('what a panel says about its own machine', () => {
    it('stores a report and hands it back on the panel row', async () => {
      const paired = await pairOne();
      await panels.recordPanelReport(paired.panelId, REPORT);

      const detail = await panels.getPanelDetail(await testTenantId(), paired.panelId);

      expect(detail.device.hostname).toBe('FRONT-DESK-PC');
      expect(detail.device.dataDir).toBe('D:\\OrderBook\\panel-data');
      expect(detail.device.storageBytes).toBe(4096);
      expect(detail.device.diskTotalBytes).toBe(512_000_000_000);
      expect(detail.device.reportedAt).not.toBeNull();
    });

    it('keeps a reported zero as zero — a full disk is not the same as an unknown one', async () => {
      const paired = await pairOne();
      await panels.recordPanelReport(paired.panelId, REPORT);

      const detail = await panels.getPanelDetail(await testTenantId(), paired.panelId);
      expect(detail.device.diskFreeBytes).toBe(0);
    });

    it('leaves every device field null on a panel that has never reported', async () => {
      const paired = await pairOne();
      const detail = await panels.getPanelDetail(await testTenantId(), paired.panelId);

      expect(detail.device.hostname).toBeNull();
      expect(detail.device.diskFreeBytes).toBeNull();
      expect(detail.device.storageBytes).toBeNull();
      expect(detail.device.reportedAt).toBeNull();
    });

    it('stamps the arrival time from the Master, not from the panel', async () => {
      const paired = await pairOne();
      // A panel whose PC thinks it is 2020 must not be able to date its own row.
      await panels.recordPanelReport(paired.panelId, { ...REPORT, startedAt: '2020-01-01T00:00:00.000Z' });

      const detail = await panels.getPanelDetail(await testTenantId(), paired.panelId);
      expect(new Date(detail.device.reportedAt ?? 0).getFullYear()).toBeGreaterThan(2020);
      expect(detail.device.startedAt).toBe('2020-01-01T00:00:00.000Z');
    });

    it('keeps the connection-only figures out of the row and in presence', async () => {
      const paired = await pairOne();
      await panels.markPanelConnected(paired.panelId, '192.168.1.20');
      await panels.recordPanelReport(paired.panelId, REPORT);

      const connected = await panels.getPanelDetail(await testTenantId(), paired.panelId);
      expect(connected.runtime?.pendingMutations).toBe(3);
      expect(connected.runtime?.signedInUsername).toBe('kiran');

      // Switched off: the machine's details survive, the live figures do not —
      // "3 changes waiting" on a panel nobody has powered on for a week is a
      // statement the Master is in no position to make.
      await panels.markPanelDisconnected(paired.panelId);
      const offline = await panels.getPanelDetail(await testTenantId(), paired.panelId);
      expect(offline.runtime).toBeNull();
      expect(offline.device.hostname).toBe('FRONT-DESK-PC');
    });
  });

  describe('editing a panel', () => {
    it('renames, notes and re-roles in one call', async () => {
      const paired = await pairOne();
      const roleId = await adminRoleId();

      const updated = await panels.updatePanel(
        paired.panelId,
        { name: 'Counter PC', notes: 'By the printer', roleId },
        await testActor(),
      );

      expect(updated.name).toBe('Counter PC');
      expect(updated.notes).toBe('By the printer');
      expect(updated.roleId).toBe(roleId);
    });

    it('leaves out fields alone, and clears a note only when told null', async () => {
      const paired = await pairOne();
      await panels.updatePanel(paired.panelId, { notes: 'By the printer' });

      const renamedOnly = await panels.updatePanel(paired.panelId, { name: 'Counter PC' });
      expect(renamedOnly.notes).toBe('By the printer');

      const cleared = await panels.updatePanel(paired.panelId, { notes: null });
      expect(cleared.notes).toBeNull();
      expect(cleared.name).toBe('Counter PC');
    });

    it('records nothing for an edit that changes nothing', async () => {
      const paired = await pairOne();
      const before = await countPanelActivity(paired.panelId);

      await panels.updatePanel(paired.panelId, { name: 'Front Desk' }, await testActor());

      expect(await countPanelActivity(paired.panelId)).toBe(before);
    });

    it('refuses a blank name and an over-long note', async () => {
      const paired = await pairOne();

      await expect(panels.updatePanel(paired.panelId, { name: '   ' })).rejects.toThrow(
        /cannot be empty/i,
      );
      await expect(
        panels.updatePanel(paired.panelId, { notes: 'x'.repeat(501) }),
      ).rejects.toThrow(/under 500/i);
    });

    it('refuses a role that does not exist, so a typo cannot widen what a panel may do', async () => {
      const paired = await pairOne();
      await expect(
        panels.updatePanel(paired.panelId, { roleId: '00000000-0000-4000-8000-000000000000' }),
      ).rejects.toThrow(/not found/i);
    });

    it('reports the seeded Office role as a fallback until one is assigned', async () => {
      const paired = await pairOne();

      const before = await panels.getPanelDetail(await testTenantId(), paired.panelId);
      expect(before.role.isFallback).toBe(true);
      expect(before.role.tier).toBe('office');

      await panels.updatePanel(paired.panelId, { roleId: await adminRoleId() });
      const after = await panels.getPanelDetail(await testTenantId(), paired.panelId);
      expect(after.role.isFallback).toBe(false);
      expect(after.role.tier).toBe('admin');
      expect(after.role.permissions.length).toBeGreaterThan(0);
    });
  });

  describe('reissuing the secret', () => {
    it('replaces the secret and tells the connected panel first', async () => {
      const paired = await pairOne();
      await panels.markPanelConnected(paired.panelId, '192.168.1.20');
      const link = fakeLink({ connected: [paired.panelId] });
      setPanelLink(link);

      const rotation = await panels.rotatePanelSecret(await testTenantId(), paired.panelId, await testActor());

      expect(rotation.delivered).toBe(true);
      expect(rotation.panelSecret).not.toBe(paired.panelSecret);
      expect(link.sent).toEqual([
        {
          panelId: paired.panelId,
          event: 'panel:credentials',
          payload: { panelSecret: rotation.panelSecret },
        },
      ]);

      // The new one works; the old one is gone.
      await expect(
        panels.authenticatePanel(paired.panelId, rotation.panelSecret),
      ).resolves.toMatchObject({ id: paired.panelId });
      await expect(panels.authenticatePanel(paired.panelId, paired.panelSecret)).rejects.toThrow(
        /not valid/i,
      );
    });

    it('leaves the old secret working when the panel refuses to take the new one', async () => {
      const paired = await pairOne();
      await panels.markPanelConnected(paired.panelId, '192.168.1.20');
      setPanelLink(fakeLink({ connected: [paired.panelId], refuse: 'Disk is full' }));

      await expect(
        panels.rotatePanelSecret(await testTenantId(), paired.panelId),
      ).rejects.toThrow(/did not answer/i);

      // The whole point of asking the panel *before* writing the hash: a panel
      // that could not store the new secret is still a working panel.
      await expect(
        panels.authenticatePanel(paired.panelId, paired.panelSecret),
      ).resolves.toMatchObject({ id: paired.panelId });
    });

    it('reissues anyway for a panel that is switched off, and says it could not be told', async () => {
      const paired = await pairOne();
      setPanelLink(fakeLink({ connected: [] }));

      const rotation = await panels.rotatePanelSecret(await testTenantId(), paired.panelId);

      expect(rotation.delivered).toBe(false);
      await expect(panels.authenticatePanel(paired.panelId, paired.panelSecret)).rejects.toThrow(
        /not valid/i,
      );
    });

    it('dates the rotation separately from any other edit', async () => {
      const paired = await pairOne();
      setPanelLink(fakeLink({ connected: [] }));

      const before = await panels.getPanelDetail(await testTenantId(), paired.panelId);
      expect(before.secretRotatedAt).toBeNull();

      await panels.rotatePanelSecret(await testTenantId(), paired.panelId);
      const rotated = await panels.getPanelDetail(await testTenantId(), paired.panelId);
      expect(rotated.secretRotatedAt).not.toBeNull();

      // A rename must not look like a credential change.
      await panels.updatePanel(paired.panelId, { name: 'Counter PC' });
      const renamed = await panels.getPanelDetail(await testTenantId(), paired.panelId);
      expect(renamed.secretRotatedAt).toBe(rotated.secretRotatedAt);
    });

    it('refuses on a revoked panel', async () => {
      const paired = await pairOne();
      await panels.revokePanel(paired.panelId);

      await expect(
        panels.rotatePanelSecret(await testTenantId(), paired.panelId),
      ).rejects.toThrow(/not active/i);
    });
  });

  describe('moving a panel’s storage', () => {
    it('passes an absolute path to the panel and reports what it did', async () => {
      const paired = await pairOne();
      await panels.markPanelConnected(paired.panelId, '192.168.1.20');
      await panels.recordPanelReport(paired.panelId, REPORT);

      const link = fakeLink({
        connected: [paired.panelId],
        answers: {
          'panel:setStoragePath': {
            dataDir: 'E:\\panel-data',
            previousDataDir: 'D:\\OrderBook\\panel-data',
            filesMoved: 6,
            bytesMoved: 4096,
            diskFreeBytes: 900,
          },
        },
      });
      setPanelLink(link);

      const result = await panels.setPanelStoragePath(
        await testTenantId(),
        paired.panelId,
        { path: 'E:\\panel-data', moveExisting: true },
        await testActor(),
      );

      expect(result.filesMoved).toBe(6);
      expect(link.sent[0]?.payload).toEqual({ path: 'E:\\panel-data', moveExisting: true });

      // The stored row follows the move immediately, rather than waiting for
      // the panel's next timed report to say where its files now are.
      const detail = await panels.getPanelDetail(await testTenantId(), paired.panelId);
      expect(detail.device.dataDir).toBe('E:\\panel-data');
      expect(detail.device.diskFreeBytes).toBe(900);
      expect(detail.device.hostname).toBe('FRONT-DESK-PC');
    });

    it('accepts a Windows path even though this Master may not be on Windows', async () => {
      const paired = await pairOne();
      await panels.markPanelConnected(paired.panelId, '192.168.1.20');
      setPanelLink(
        fakeLink({
          connected: [paired.panelId],
          answers: {
            'panel:setStoragePath': {
              dataDir: 'D:\\data',
              previousDataDir: 'C:\\old',
              filesMoved: 0,
              bytesMoved: 0,
              diskFreeBytes: null,
            },
          },
        }),
      );

      await expect(
        panels.setPanelStoragePath(await testTenantId(), paired.panelId, {
          path: 'D:\\data',
          moveExisting: false,
        }),
      ).resolves.toMatchObject({ dataDir: 'D:\\data' });
    });

    it('refuses a relative path before troubling the panel with it', async () => {
      const paired = await pairOne();
      await panels.markPanelConnected(paired.panelId, '192.168.1.20');
      const link = fakeLink({ connected: [paired.panelId] });
      setPanelLink(link);

      await expect(
        panels.setPanelStoragePath(await testTenantId(), paired.panelId, {
          path: 'panel-data',
          moveExisting: true,
        }),
      ).rejects.toThrow(/full path/i);
      expect(link.sent).toHaveLength(0);
    });

    it('refuses when the panel is not connected — it is the panel that does the moving', async () => {
      const paired = await pairOne();
      setPanelLink(fakeLink({ connected: [] }));

      await expect(
        panels.setPanelStoragePath(await testTenantId(), paired.panelId, {
          path: '/srv/panel-data',
          moveExisting: true,
        }),
      ).rejects.toThrow(/offline/i);
    });

    it('surfaces the panel’s own refusal rather than a generic failure', async () => {
      const paired = await pairOne();
      await panels.markPanelConnected(paired.panelId, '192.168.1.20');
      setPanelLink(fakeLink({ connected: [paired.panelId], refuse: 'Cannot write to E:\\panel-data' }));

      await expect(
        panels.setPanelStoragePath(await testTenantId(), paired.panelId, {
          path: 'E:\\panel-data',
          moveExisting: true,
        }),
      ).rejects.toMatchObject({ details: { reason: 'Cannot write to E:\\panel-data' } });
    });
  });

  describe('what the screen reads back', () => {
    it('refuses a panel belonging to another company', async () => {
      const paired = await pairOne();
      await expect(
        panels.getPanelDetail('00000000-0000-4000-8000-000000000000', paired.panelId),
      ).rejects.toThrow(/not found/i);
    });

    it('shows both what the panel did and what was done to it', async () => {
      const paired = await pairOne();
      await panels.updatePanel(paired.panelId, { name: 'Counter PC' }, await testActor());

      const tenantId = await testTenantId();
      await activityLog.recordDetachedActivity(
        {
          tenantId,
          entityType: 'lead',
          entityId: 'LD0000000001',
          action: 'created',
          actorType: 'office_panel',
          actorId: paired.panelId,
          details: {},
        },
        await testActor({ actorType: 'office_panel', actorId: paired.panelId }),
        db(),
      );

      const entries = await panels.listPanelActivity(tenantId, paired.panelId, 50, UNSCOPED_PARTY_ACCESS);

      expect(entries.some((entry) => entry.entityType === 'office_panel')).toBe(true);
      expect(entries.some((entry) => entry.actor.type === 'office_panel')).toBe(true);
    });

    it('refuses to edit or revoke a panel from another company', async () => {
      const paired = await pairOne();
      const stranger = await testActor({ tenantId: '00000000-0000-4000-8000-000000000000' });

      await expect(
        panels.updatePanel(paired.panelId, { name: 'Theirs' }, stranger),
      ).rejects.toThrow(/not found/i);
      await expect(panels.revokePanel(paired.panelId, stranger)).rejects.toThrow(/not found/i);

      // And nothing happened to it.
      const detail = await panels.getPanelDetail(await testTenantId(), paired.panelId);
      expect(detail.name).toBe('Front Desk');
      expect(detail.status).toBe('active');
    });

    it('counts nothing for a panel that has raised nothing', async () => {
      const paired = await pairOne();
      const detail = await panels.getPanelDetail(await testTenantId(), paired.panelId);

      expect(detail.work).toEqual({ leads: 0, orders: 0, lastActionAt: null });
    });
  });
});

async function adminRoleId(): Promise<string> {
  const row = await db()('roles')
    .where({ tenant_id: await testTenantId(), tier: 'admin' })
    .first<{ id: string }>('id');
  if (!row) throw new Error('No seeded admin role');
  return row.id;
}

async function countPanelActivity(panelId: string): Promise<number> {
  const row = await db()('activity_log')
    .where({ entity_type: 'office_panel', entity_id: panelId })
    .count<Array<{ count: string }>>('id as count');
  return Number(row[0]?.count ?? 0);
}
