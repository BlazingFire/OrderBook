import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { db } from '../src/db/knex.js';
import { canRunIntegrationTests } from './helpers/db.js';
import {
  resetData,
  setUpFirstRun,
  setupDatabase,
  teardownDatabase,
  testTenantId,
} from './helpers/fixtures.js';
import * as auth from '../src/services/auth.service.js';
import * as panels from '../src/services/panel.service.js';
import * as setup from '../src/services/setup.service.js';

/** A Server Master signs in only on the Master PC; the HTTP route says so from loopback. */
const MASTER_PC = { onMasterPc: true };

describe.skipIf(!canRunIntegrationTests)('setup, auth and pairing (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    panels.closePairingWindow();
  });

  describe('first-run setup', () => {
    it('reports setup as incomplete on an empty database', async () => {
      expect(await setup.isSetupComplete()).toBe(false);
      expect(await setup.getIdentity()).toBeNull();
    });

    it('creates the two Server Masters and the master identity, and no admin', async () => {
      const credentials = await setUpFirstRun('Shree Ceramics');

      expect(credentials.accounts.map((account) => account.username)).toEqual(['master', 'master-backup']);
      expect(credentials.pairingPassword).toHaveLength(10);
      const tiers = await db()('users as u')
        .join('roles as r', 'r.id', 'u.role_id')
        .orderBy('u.username')
        .select<Array<{ username: string; tier: string }>>('u.username', 'r.tier');
      expect(tiers).toEqual([
        { username: 'master', tier: 'server_master' },
        { username: 'master-backup', tier: 'server_master' },
      ]);
      expect(await setup.isSetupComplete()).toBe(true);

      const identity = await setup.getIdentity();
      expect(identity?.companyName).toBe('Shree Ceramics');
      expect(identity?.masterUniqueId).toBe(credentials.masterUniqueId);
    });

    it('generates a pairing password without characters that are easy to misread', async () => {
      // Copied off one screen and typed into another by hand, so 0/O and
      // 1/l/I must not appear. The sign-in passwords are the owner's own now.
      const credentials = await setUpFirstRun();

      expect(credentials.pairingPassword).not.toMatch(/[0O1lI]/);
    });

    it('generates a different pairing password and identity each run', async () => {
      const first = await setUpFirstRun();
      await resetData();
      const second = await setUpFirstRun();

      expect(first.pairingPassword).not.toBe(second.pairingPassword);
      expect(first.masterUniqueId).not.toBe(second.masterUniqueId);
    });

    it('refuses to run twice, so an existing installation cannot be reset from the browser', async () => {
      await setUpFirstRun();
      await expect(setUpFirstRun()).rejects.toThrow(/already been set up/i);
    });

    it('refuses a short password, or two accounts with one username, before writing anything', async () => {
      await expect(
        setup.runFirstTimeSetup(null, [
          { username: 'master', displayName: 'Main', password: 'short' },
          { username: 'master-backup', displayName: 'Backup', password: 'long-enough-1' },
        ]),
      ).rejects.toThrow();
      await expect(
        setup.runFirstTimeSetup(null, [
          { username: 'master', displayName: 'Main', password: 'long-enough-1' },
          { username: 'MASTER', displayName: 'Backup', password: 'long-enough-2' },
        ]),
      ).rejects.toThrow();
      await expect(
        setup.runFirstTimeSetup(null, [{ username: 'master', displayName: 'Main', password: 'long-enough-1' }]),
      ).rejects.toThrow();
      expect(await setup.isSetupComplete()).toBe(false);
    });
  });

  describe('sign in', () => {
    it('accepts the generated password', async () => {
      const credentials = await setUpFirstRun();
      const result = await auth.signIn('master', credentials.password, undefined, MASTER_PC);

      expect(result.user.username).toBe('master');
      expect(result.token).toBeTruthy();
    });

    it('is case-insensitive on the username', async () => {
      const credentials = await setUpFirstRun();
      await expect(auth.signIn('MASTER', credentials.password, undefined, MASTER_PC)).resolves.toBeTruthy();
    });

    it('rejects a wrong password', async () => {
      await setUpFirstRun();
      await expect(auth.signIn('master', 'WRONGPASS1')).rejects.toThrow(/sign-in failed/i);
    });

    it('rejects an unknown user with the same message as a wrong password', async () => {
      await setUpFirstRun();
      // Identical wording so the form cannot be used to discover valid usernames.
      await expect(auth.signIn('nobody', 'whatever')).rejects.toThrow(/sign-in failed/i);
    });

    it('counts down in the singular when one attempt is left', async () => {
      await setUpFirstRun();
      // A name no other test signs in as: the failure counter is per username
      // and lives for the life of the process.
      await expect(auth.signIn('countdown', 'wrong')).rejects.toThrow('2 attempts left');
      await expect(auth.signIn('countdown', 'wrong')).rejects.toThrow('1 attempt left');
    });

    it('issues a session that resolves back to the user', async () => {
      const credentials = await setUpFirstRun();
      const { token } = await auth.signIn('master', credentials.password, undefined, MASTER_PC);

      expect((await auth.resolveSession(token, '127.0.0.1'))?.username).toBe('master');
    });

    it('does not resolve an unknown or missing token', async () => {
      expect(await auth.resolveSession('made-up-token')).toBeNull();
      expect(await auth.resolveSession(undefined)).toBeNull();
    });

    it('stops resolving a token after sign out', async () => {
      const credentials = await setUpFirstRun();
      const { token } = await auth.signIn('master', credentials.password, undefined, MASTER_PC);

      await auth.signOut(token, '127.0.0.1');
      expect(await auth.resolveSession(token, '127.0.0.1')).toBeNull();
    });
  });

  describe('pairing window', () => {
    it('is closed by default, so a panel cannot join unannounced', () => {
      expect(panels.isAcceptingPairing()).toBe(false);
    });

    it('opens and closes on request', () => {
      panels.openPairingWindow();
      expect(panels.isAcceptingPairing()).toBe(true);

      panels.closePairingWindow();
      expect(panels.isAcceptingPairing()).toBe(false);
    });
  });

  describe('auto pairing', () => {
    it('is refused while the window is closed', async () => {
      await setUpFirstRun();

      await expect(
        panels.pairPanel({ mode: 'auto', panelName: 'Front Desk', hostname: 'pc1' }, '192.168.1.20'),
      ).rejects.toThrow(/not accepting new panels/i);
    });

    it('succeeds while the window is open and records the panel', async () => {
      await setUpFirstRun();
      panels.openPairingWindow();

      const result = await panels.pairPanel(
        { mode: 'auto', panelName: 'Front Desk', hostname: 'pc1' },
        '192.168.1.20',
      );

      expect(result.panelSecret).toBeTruthy();

      const list = await panels.listPanelsWithPresence(await testTenantId());
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ name: 'Front Desk', lanIp: '192.168.1.20', status: 'active' });
    });

    it('closes the window after one panel joins, so leaving the screen open admits only one', async () => {
      await setUpFirstRun();
      panels.openPairingWindow();

      await panels.pairPanel({ mode: 'auto', panelName: 'First', hostname: 'pc1' }, null);
      expect(panels.isAcceptingPairing()).toBe(false);

      await expect(
        panels.pairPanel({ mode: 'auto', panelName: 'Second', hostname: 'pc2' }, null),
      ).rejects.toThrow(/not accepting/i);
    });

    it('names an unnamed panel automatically', async () => {
      await setUpFirstRun();
      panels.openPairingWindow();

      const result = await panels.pairPanel({ mode: 'auto', panelName: '', hostname: 'pc1' }, null);
      const panel = await panels.listPanelsWithPresence(await testTenantId());

      expect(panel.find((entry) => entry.id === result.panelId)?.name).toBe('Office Panel 1');
    });

    it('is refused before first-run setup has happened', async () => {
      panels.openPairingWindow();
      await expect(
        panels.pairPanel({ mode: 'auto', panelName: 'Front Desk', hostname: 'pc1' }, null),
      ).rejects.toThrow(/first-run setup/i);
    });
  });

  describe('manual pairing', () => {
    it('succeeds with the correct pairing password even when the window is closed', async () => {
      const credentials = await setUpFirstRun();

      const result = await panels.pairPanel(
        {
          mode: 'manual',
          panelName: 'Back Office',
          hostname: 'pc2',
          pairingPassword: credentials.pairingPassword,
        },
        null,
      );

      expect(result.panelId).toBeTruthy();
    });

    it('rejects a wrong pairing password', async () => {
      await setUpFirstRun();

      await expect(
        panels.pairPanel(
          { mode: 'manual', panelName: 'X', hostname: 'pc2', pairingPassword: 'NOPE123456' },
          null,
        ),
      ).rejects.toThrow(/incorrect pairing password/i);
    });

    it('rejects a mismatched master id, so a panel cannot join the wrong master', async () => {
      const credentials = await setUpFirstRun();

      await expect(
        panels.pairPanel(
          {
            mode: 'manual',
            panelName: 'X',
            hostname: 'pc2',
            pairingPassword: credentials.pairingPassword,
            masterUniqueId: '00000000-0000-4000-8000-000000000000',
          },
          null,
        ),
      ).rejects.toThrow(/different master panel/i);
    });
  });

  describe('panel credentials', () => {
    async function pairOne() {
      await setUpFirstRun();
      panels.openPairingWindow();
      return panels.pairPanel({ mode: 'auto', panelName: 'Front Desk', hostname: 'pc1' }, null);
    }

    it('authenticates a paired panel', async () => {
      const paired = await pairOne();
      const panel = await panels.authenticatePanel(paired.panelId, paired.panelSecret);

      expect(panel.name).toBe('Front Desk');
    });

    it('rejects a wrong secret', async () => {
      const paired = await pairOne();
      await expect(panels.authenticatePanel(paired.panelId, 'wrong-secret')).rejects.toThrow(
        /not valid/i,
      );
    });

    it('rejects an unknown panel id', async () => {
      await pairOne();
      await expect(
        panels.authenticatePanel('00000000-0000-4000-8000-000000000000', 'x'),
      ).rejects.toThrow(/not paired/i);
    });

    it('rejects a revoked panel even with the right secret', async () => {
      const paired = await pairOne();
      await panels.revokePanel(paired.panelId);

      await expect(panels.authenticatePanel(paired.panelId, paired.panelSecret)).rejects.toThrow(
        /not paired/i,
      );
    });

    it('keeps a revoked panel in the list so lead history stays attributable', async () => {
      const paired = await pairOne();
      await panels.revokePanel(paired.panelId);

      const list = await panels.listPanelsWithPresence(await testTenantId());
      expect(list).toHaveLength(1);
      expect(list[0]?.status).toBe('revoked');
    });

    it('gives each panel a distinct secret', async () => {
      const first = await pairOne();
      panels.openPairingWindow();
      const second = await panels.pairPanel(
        { mode: 'auto', panelName: 'Second', hostname: 'pc2' },
        null,
      );

      expect(first.panelSecret).not.toBe(second.panelSecret);
    });

    it('tracks live presence separately from the stored row', async () => {
      const paired = await pairOne();
      expect(panels.isPanelConnected(paired.panelId)).toBe(false);

      await panels.markPanelConnected(paired.panelId, '192.168.1.20');
      expect(panels.isPanelConnected(paired.panelId)).toBe(true);
      expect((await panels.listPanelsWithPresence(await testTenantId()))[0]?.isConnected).toBe(true);

      await panels.markPanelDisconnected(paired.panelId);
      expect(panels.isPanelConnected(paired.panelId)).toBe(false);
    });

    it('renames a panel', async () => {
      const paired = await pairOne();
      const renamed = await panels.renamePanel(paired.panelId, 'Counter PC');

      expect(renamed.name).toBe('Counter PC');
    });

    it('refuses a blank panel name', async () => {
      const paired = await pairOne();
      await expect(panels.renamePanel(paired.panelId, '  ')).rejects.toThrow(/cannot be empty/i);
    });
  });
});
