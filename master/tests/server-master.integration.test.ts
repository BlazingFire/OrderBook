/**
 * The Server Master tier against a real database, hub and HTTP stack
 * (docs/plans/1.3-BATCH.md, Phase 2).
 *
 * What is proved here is the set of rules nothing else would notice breaking:
 * the reserved role still holds every permission after every migration; a
 * Server Master signs in and stays signed in only on the Master PC, never
 * through an Office panel, even one connecting from 127.0.0.1; an admin cannot
 * touch a Server Master; two must remain; and their credentials move only with
 * the master key.
 *
 * The master key itself is never in a test. The gate is swapped for one that
 * checks a test-only key, with the same lockout and tokens.
 */

import { randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import express, { type Express } from 'express';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { allPermissions, MASTER_KEY_TOKEN_HEADER, type Role } from '@orderbook/shared';

import { acceptAuditEntries, refuseAuditEntries } from './helpers/audit-probe.js';
import { canRunIntegrationTests } from './helpers/db.js';
import {
  createServerMasterUser,
  FIRST_RUN_ACCOUNTS,
  resetData,
  setUpFirstRun,
  setupDatabase,
  teardownDatabase,
  testActor,
  testTenantId,
} from './helpers/fixtures.js';
import type { DeveloperGate } from '../src/services/developer.service.js';
import type * as MasterKeyService from '../src/services/master-key.service.js';

const keys = vi.hoisted(() => ({ gate: undefined as DeveloperGate | undefined }));

vi.mock('../src/services/master-key.service.js', async (importOriginal) => {
  const original = await importOriginal<typeof MasterKeyService>();
  const live: DeveloperGate = {
    unlock: (key) => keys.gate!.unlock(key),
    status: (token) => keys.gate!.status(token),
    lock: (token) => keys.gate!.lock(token),
    assertUnlocked: (token) => keys.gate!.assertUnlocked(token),
  };
  return {
    ...original,
    masterKeyGate: live,
    verifyMasterKey: (key: unknown, actor: Parameters<typeof original.verifyMasterKey>[1]) =>
      original.verifyMasterKey(key, actor, live),
  };
});

const { db } = await import('../src/db/knex.js');
const { createApp } = await import('../src/http/app.js');
const { hashPassword } = await import('../src/lib/password.js');
const { createRealtimeHub } = await import('../src/realtime/hub.js');
const panelCredentialRepo = await import('../src/repositories/panel-credential.repository.js');
const panelRepo = await import('../src/repositories/office-panel.repository.js');
const authService = await import('../src/services/auth.service.js');
const avatarService = await import('../src/services/avatar.service.js');
const { createMasterKeyGate, masterKeyGate } = await import('../src/services/master-key.service.js');
const panelService = await import('../src/services/panel.service.js');
const roleService = await import('../src/services/role.service.js');
const passwordVaultService = await import('../src/services/password-vault.service.js');
const serverMasters = await import('../src/services/server-master.service.js');
const settingsService = await import('../src/services/settings.service.js');
const { verifyPairingPassword } = await import('../src/services/setup.service.js');
const userService = await import('../src/services/user.service.js');

/** Test-only; the real key is in docs/MASTER_KEY.md and nowhere else. */
const TEST_KEY = 'test-master-key-for-integration';
let testKeyHash: string;

const MAIN = FIRST_RUN_ACCOUNTS[0]!;
const BACKUP = FIRST_RUN_ACCOUNTS[1]!;
const LAN = '192.168.1.5';

/** The live Server Master role. */
async function serverMasterRole(): Promise<Role> {
  const role = (await roleService.listRoles(await testActor())).find((r) => r.tier === 'server_master');
  if (!role) throw new Error('No Server Master role');
  return role;
}

/** Acting as a Server Master, the way a session on the Master PC resolves. */
async function serverMasterActor(userId: string | null = null) {
  return testActor({
    actorId: userId,
    userId,
    permissions: { roleId: null, roleName: 'Server Master', tier: 'server_master', permissions: allPermissions() },
  });
}

async function userIdOf(username: string): Promise<string> {
  const row = await db()('users').where({ username }).first<{ id: string }>('id');
  if (!row) throw new Error(`No user ${username}`);
  return row.id;
}

async function userRow(username: string) {
  return userService.getUser(await userIdOf(username), await testActor());
}

/** `app` as it looks from another PC on the LAN. */
function fromLan(app: Express): Express {
  const lan = express();
  lan.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: LAN, configurable: true });
    next();
  });
  lan.use(app);
  return lan;
}

describe.skipIf(!canRunIntegrationTests)('the Server Master tier (integration)', () => {
  let app: Express;

  beforeAll(async () => {
    await setupDatabase();
    app = createApp();
    testKeyHash = await hashPassword(TEST_KEY);
  });
  afterAll(teardownDatabase);

  beforeEach(async () => {
    await resetData();
    keys.gate = createMasterKeyGate({ passwordHash: testKeyHash });
  });

  describe('the reserved role', () => {
    it('holds every permission there is, after every migration', async () => {
      const roles = await db()('roles')
        .where({ tenant_id: await testTenantId(), tier: 'server_master' })
        .whereNull('deleted_at')
        .select<Array<{ is_system: boolean; permissions: string[] }>>('is_system', 'permissions');

      // A later migration that grants a new key to admin and forgets the
      // Server Master fails here.
      expect(roles).toHaveLength(1);
      expect(roles[0]!.is_system).toBe(true);
      expect([...roles[0]!.permissions].sort()).toEqual([...allPermissions()].sort());
    });

    it('is frozen, and no other role may take its tier', async () => {
      const actor = await serverMasterActor();
      const role = await serverMasterRole();

      await expect(
        roleService.updateRole(
          role.id,
          { name: 'Owners', tier: 'server_master', permissions: role.permissions, expectedVersion: role.sync.version },
          actor,
        ),
      ).rejects.toMatchObject({ messageKey: 'validation.role.serverMasterLocked' });
      await expect(roleService.deleteRole(role.id, actor)).rejects.toMatchObject({
        messageKey: 'validation.role.serverMasterLocked',
      });
      await expect(
        roleService.createRole({ name: 'Second owners', tier: 'server_master', permissions: [] }, actor),
      ).rejects.toMatchObject({ messageKey: 'validation.role.serverMasterReserved' });
    });
  });

  describe('signing in and staying signed in', () => {
    it('refuses a Server Master off the Master PC after the password checks out, and says why in the trail', async () => {
      await setUpFirstRun();

      await expect(authService.signIn(MAIN.username, MAIN.password)).rejects.toMatchObject({
        messageKey: 'error.unauthorized.serverMasterMasterPcOnly',
      });
      // A wrong password still reads as a wrong password, so this is no oracle.
      await expect(authService.signIn(MAIN.username, 'not-the-password')).rejects.toThrow(/sign-in failed/i);

      const refused = await db()('activity_log')
        .where({ action: 'sign_in_failed' })
        .whereRaw("details->>'reason' = 'masterPcOnly'")
        .first();
      expect(refused).toBeDefined();
    });

    it('resolves a Server Master session only from loopback, and a LAN refusal does not end it', async () => {
      await setUpFirstRun();
      const { token } = await authService.signIn(MAIN.username, MAIN.password, undefined, { onMasterPc: true });

      expect(await authService.resolveSessionWithPermissions(token, LAN)).toBeNull();
      expect(await authService.resolveSessionWithPermissions(token)).toBeNull();
      expect(await authService.resolveSessionDetailed(token, LAN)).toEqual({ status: 'rejected', reason: 'expired' });

      for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
        expect((await authService.resolveSession(token, address))?.username).toBe(MAIN.username);
      }
    });

    it('turns a LAN browser away from Server Master sign-in and keeps admins working there', async () => {
      await setUpFirstRun();
      const lan = fromLan(app);

      const refused = await request(lan)
        .post('/api/auth/sign-in')
        .send({ username: MAIN.username, password: MAIN.password })
        .expect(401);
      expect(refused.body.messageKey).toBe('error.unauthorized.serverMasterMasterPcOnly');

      const adminRole = (await roleService.listRoles(await testActor())).find(
        (r) => r.isSystem && r.tier === 'admin',
      )!;
      await userService.createUser(
        { username: 'meena', displayName: 'Meena', roleId: adminRole.id, password: 'correct-horse' },
        await testActor(),
      );
      const admin = request.agent(lan);
      await admin.post('/api/auth/sign-in').send({ username: 'meena', password: 'correct-horse' }).expect(200);
      await admin.get('/api/auth/me').expect(200);
    });

    it('does not honour a Server Master cookie carried to another PC', async () => {
      await setUpFirstRun();
      const local = request.agent(app);
      const signedIn = await local
        .post('/api/auth/sign-in')
        .send({ username: MAIN.username, password: MAIN.password })
        .expect(200);
      const cookie = signedIn.headers['set-cookie'] as unknown as string[];

      await local.get('/api/auth/me').expect(200);
      await request(fromLan(app)).get('/api/auth/me').set('Cookie', cookie).expect(401);
      // …and the owner on the Master PC is still signed in.
      await local.get('/api/auth/me').expect(200);
    });

    it('ends a Server Master session only from the Master PC, and logs it', async () => {
      await setUpFirstRun();
      const { token } = await authService.signIn(MAIN.username, MAIN.password, undefined, { onMasterPc: true });

      // A copied cookie cannot sign the owner out from the LAN either.
      await authService.signOut(token, LAN);
      expect(await authService.resolveSession(token, '127.0.0.1')).not.toBeNull();

      await authService.signOut(token, '::1');
      expect(await authService.resolveSession(token, '127.0.0.1')).toBeNull();

      const row = await db()('activity_log').where({ action: 'signed_out' }).first();
      expect(row).toMatchObject({ entity_type: 'user', entity_id: await userIdOf(MAIN.username) });
      expect(row.details).toMatchObject({ username: MAIN.username });
    });
  });

  describe('Office panels', () => {
    let server: HttpServer;
    let hub: Awaited<ReturnType<typeof createRealtimeHub>>;
    let sockets: Socket[] = [];
    let panelIds: string[] = [];

    beforeAll(async () => {
      server = createServer();
      hub = createRealtimeHub(server);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    });
    afterAll(async () => {
      await hub.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    afterEach(async () => {
      const closedAt = ((await db().raw('SELECT now() AS at')).rows as Array<{ at: Date }>)[0]?.at ?? new Date(0);
      for (const socket of sockets) socket.close();
      sockets = [];

      // The Master stamps last_seen_at as each disconnect lands. Wait for it,
      // or the next test's TRUNCATE can deadlock with that update.
      for (let tries = 0; tries < 250 && panelIds.length > 0; tries += 1) {
        const [pending] = await db()('office_panels')
          .whereIn('id', panelIds)
          .where((query) => query.whereNull('last_seen_at').orWhere('last_seen_at', '<', closedAt))
          .count<Array<{ n: string }>>('id as n');
        if (Number(pending?.n) === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      panelIds = [];
    });

    /** A paired panel connecting from this very PC — the closest a panel gets to the Master. */
    async function connectPanel(): Promise<{ socket: Socket; panelId: string }> {
      const panelId = randomUUID();
      await panelRepo.insertPanel({
        id: panelId,
        tenant_id: await testTenantId(),
        name: 'Front desk',
        device_code: 'SMTEST',
        secret_hash: await bcrypt.hash('panel-secret', 4),
        lan_ip: '127.0.0.1',
        status: 'active',
        paired_at: new Date(),
      });
      const { port } = server.address() as AddressInfo;
      const socket = connect(`http://127.0.0.1:${port}`, {
        transports: ['websocket'],
        auth: { kind: 'office-panel', panelId, panelSecret: 'panel-secret', protocol: 2 },
      });
      sockets.push(socket);
      panelIds.push(panelId);
      await new Promise<void>((resolve, reject) => {
        socket.once('sync:snapshot', () => resolve());
        socket.once('connect_error', reject);
      });
      return { socket, panelId };
    }

    const ask = <T>(socket: Socket, event: string, payload: unknown): Promise<T> =>
      new Promise((resolve) => socket.emit(event, payload, resolve));

    it('refuses a Server Master sign-in on a panel connecting from 127.0.0.1', async () => {
      await setUpFirstRun();
      const { socket } = await connectPanel();

      const ack = await ask<{ ok: boolean; messageKey?: string }>(socket, 'auth:signIn', {
        username: MAIN.username,
        password: MAIN.password,
      });
      expect(ack).toMatchObject({ ok: false, messageKey: 'error.unauthorized.serverMasterMasterPcOnly' });
    });

    it('will not act as a Server Master whose token it was handed', async () => {
      await setUpFirstRun();
      const { socket } = await connectPanel();
      const { token } = await authService.signIn(MAIN.username, MAIN.password, undefined, { onMasterPc: true });

      const ack = await ask<{ ok: boolean; data: unknown }>(socket, 'auth:assume', token);
      expect(ack).toEqual({ ok: true, data: { status: 'rejected', reason: 'expired' } });
      // Refused there, still fine on the Master PC.
      expect(await authService.resolveSession(token, '127.0.0.1')).not.toBeNull();
    });

    it('tells a panel to forget a cached verifier for somebody now a Server Master', async () => {
      await setUpFirstRun();
      const tenantId = await testTenantId();
      const userId = await userIdOf(BACKUP.username);
      const fingerprint = (await panelCredentialRepo.fingerprintForUser(tenantId, userId)) ?? '';

      expect(
        await panelCredentialRepo.findRevokedOfflineCredentials(tenantId, [
          { userId, credentialFingerprint: fingerprint },
        ]),
      ).toEqual([userId]);
    });

    it('records the protocol a panel announced', async () => {
      const { panelId } = await connectPanel();
      const panels = await panelService.listPanelsWithPresence(await testTenantId());
      expect(panels.find((p) => p.id === panelId)?.runtime?.protocol).toBe(2);
    });

    it('logs the sign-ins a panel checked offline, skipping a malformed one', async () => {
      await setUpFirstRun();
      const { socket } = await connectPanel();

      const ack = await ask<{ ok: boolean; data: { recorded: number } }>(socket, 'auth:offlineEvents', [
        { username: 'sunita', success: true, at: '2026-10-01T09:00:00.000Z' },
        { username: 'nobody', success: false, at: '2026-10-01T09:05:00.000Z' },
        { username: 'broken', success: 'yes', at: 'not a date' },
      ]);
      expect(ack).toEqual({ ok: true, data: { recorded: 2 } });

      const rows = await db()('activity_log')
        .whereIn('action', ['offline_sign_in', 'offline_sign_in_failed'])
        .orderBy('id')
        .select('action', 'details');
      expect(rows.map((row) => row.action)).toEqual(['offline_sign_in', 'offline_sign_in_failed']);
      expect(rows[0].details).toMatchObject({ username: 'sunita', source: 'SMTEST', at: '2026-10-01T09:00:00.000Z' });

      const tooMany = await ask<{ ok: boolean; messageKey?: string }>(
        socket,
        'auth:offlineEvents',
        Array.from({ length: authService.MAX_OFFLINE_EVENTS + 1 }, () => ({
          username: 'sunita',
          success: true,
          at: '2026-10-01T09:00:00.000Z',
        })),
      );
      expect(tooMany).toMatchObject({ ok: false, messageKey: 'validation.offlineEvents.tooMany' });
    });

    it('logs a resent batch once, and a refused one not at all', async () => {
      await setUpFirstRun();
      const { socket } = await connectPanel();
      const events = [
        { id: 'event-1', username: 'sunita', success: true, at: '2026-10-01T09:00:00.000Z' },
        { id: 'event-2', username: 'imran', success: false, at: '2026-10-01T09:05:00.000Z' },
      ];
      const offlineRows = () =>
        db()('activity_log').whereIn('action', ['offline_sign_in', 'offline_sign_in_failed']).count('id as n');

      // The ack was lost, so the panel sends the same batch again.
      expect(await ask(socket, 'auth:offlineEvents', events)).toEqual({ ok: true, data: { recorded: 2 } });
      expect(await ask(socket, 'auth:offlineEvents', events)).toEqual({ ok: true, data: { recorded: 0 } });
      expect(await offlineRows()).toEqual([{ n: '2' }]);

      // The second entry of a fresh batch is refused: the first is not kept either.
      await refuseAuditEntries('offline_sign_in_failed');
      try {
        const refused = await ask<{ ok: boolean }>(socket, 'auth:offlineEvents', [
          { id: 'event-3', username: 'sunita', success: true, at: '2026-10-02T09:00:00.000Z' },
          { id: 'event-4', username: 'imran', success: false, at: '2026-10-02T09:05:00.000Z' },
        ]);
        expect(refused.ok).toBe(false);
      } finally {
        await acceptAuditEntries();
      }
      expect(await offlineRows()).toEqual([{ n: '2' }]);
    });

    it('cannot be given the Server Master role', async () => {
      const { panelId } = await connectPanel();
      const role = await serverMasterRole();

      await expect(
        panelService.updatePanel(panelId, { roleId: role.id }, await serverMasterActor()),
      ).rejects.toMatchObject({ messageKey: 'validation.panel.serverMasterRole' });
    });
  });

  describe('managing Server Master accounts', () => {
    it('gives an admin no way to change a Server Master', async () => {
      await setUpFirstRun();
      const admin = await testActor();
      const target = await userRow(MAIN.username);
      const officeRole = (await roleService.listRoles(admin)).find((r) => r.tier === 'office')!;
      const refused = { messageKey: 'error.forbidden.serverMasterTarget' };

      await expect(
        userService.updateUser(target.id, { isActive: false, expectedVersion: target.sync.version }, admin),
      ).rejects.toMatchObject(refused);
      await expect(
        userService.updateUser(target.id, { roleId: officeRole.id, expectedVersion: target.sync.version }, admin),
      ).rejects.toMatchObject(refused);
      await expect(userService.resetPassword({ userId: target.id }, admin)).rejects.toMatchObject(refused);
      await expect(userService.deleteUser(target.id, admin)).rejects.toMatchObject(refused);
      await expect(avatarService.removeAvatar(target.id, admin)).rejects.toMatchObject(refused);

      expect((await userRow(MAIN.username)).isActive).toBe(true);
    });

    it('keeps two Server Masters, even for a Server Master holding the key', async () => {
      await setUpFirstRun();
      const actor = await serverMasterActor(await userIdOf(MAIN.username));
      const { token } = await masterKeyGate.unlock(TEST_KEY);
      const backup = await userRow(BACKUP.username);

      await expect(
        userService.updateUser(
          backup.id,
          { isActive: false, expectedVersion: backup.sync.version },
          actor,
          { masterKeyToken: token },
        ),
      ).rejects.toMatchObject({ messageKey: 'validation.user.serverMastersRequired' });
      await expect(userService.deleteUser(backup.id, actor, { masterKeyToken: token })).rejects.toMatchObject({
        messageKey: 'validation.user.serverMastersRequired',
      });
      expect((await userRow(BACKUP.username)).isActive).toBe(true);
    });

    it('lets a third Server Master go only with the master key', async () => {
      await setUpFirstRun();
      await createServerMasterUser('third-owner');
      const actor = await serverMasterActor(await userIdOf(MAIN.username));
      const third = await userRow('third-owner');

      await expect(
        userService.updateUser(third.id, { isActive: false, expectedVersion: third.sync.version }, actor),
      ).rejects.toMatchObject({ messageKey: 'error.unauthorized.masterKeyRequired' });

      const { token } = await masterKeyGate.unlock(TEST_KEY);
      await expect(
        userService.updateUser(
          third.id,
          { isActive: false, expectedVersion: third.sync.version },
          actor,
          { masterKeyToken: token },
        ),
      ).resolves.toMatchObject({ isActive: false });
    });

    it('lets a Server Master change a display name without the key, even sent with unchanged fields', async () => {
      await setUpFirstRun();
      const actor = await serverMasterActor(await userIdOf(MAIN.username));
      const backup = await userRow(BACKUP.username);

      await expect(
        userService.updateUser(
          backup.id,
          {
            displayName: 'Backup Owner',
            username: backup.username,
            isActive: true,
            expectedVersion: backup.sync.version,
          },
          actor,
        ),
      ).resolves.toMatchObject({ displayName: 'Backup Owner' });
    });

    it('needs the master key for a Server Master to change their own password', async () => {
      await setUpFirstRun();
      const agent = request.agent(app);
      await agent.post('/api/auth/sign-in').send({ username: MAIN.username, password: MAIN.password }).expect(200);
      const change = { currentPassword: MAIN.password, newPassword: 'a-new-long-password' };

      const refused = await agent.post('/api/access/me/password').send(change).expect(401);
      expect(refused.body.messageKey).toBe('error.unauthorized.masterKeyRequired');

      const verified = await agent.post('/api/master-key/verify').send({ key: TEST_KEY }).expect(201);
      await agent
        .post('/api/access/me/password')
        .set(MASTER_KEY_TOKEN_HEADER, verified.body.token)
        .send(change)
        .expect(204);
      await expect(
        authService.signIn(MAIN.username, 'a-new-long-password', undefined, { onMasterPc: true }),
      ).resolves.toBeTruthy();
    });

    it('locks the master key for a minute after five wrong tries', async () => {
      const agent = request.agent(app);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const wrong = await agent.post('/api/master-key/verify').send({ key: 'not-it' }).expect(401);
        expect(wrong.body.messageKey).toBe('error.unauthorized.masterKey');
      }

      // Even the right key now waits out the lock.
      await agent.post('/api/master-key/verify').send({ key: TEST_KEY }).expect(429);
      expect(await db()('activity_log').where({ entity_type: 'master_key', action: 'failed' }).count('id as n'))
        .toEqual([{ n: '5' }]);
    });
  });

  describe('the master-key flows', () => {
    it('rejects a tier the database does not know', async () => {
      await setUpFirstRun();
      await expect(db()('roles').where({ tier: 'admin' }).update({ tier: 'bogus' })).rejects.toThrow(
        /roles_tier_check/,
      );
    });

    it('sets up exactly the missing Server Masters, and refuses once there are two', async () => {
      await setUpFirstRun();
      await db()('users').where({ username: BACKUP.username }).update({ is_active: false });
      const { token } = await masterKeyGate.unlock(TEST_KEY);
      const third = { username: 'master-third', displayName: 'Third', password: 'third-pass-3' };

      await expect(
        serverMasters.setUpMissingServerMasters([third, { ...third, username: 'master-fourth' }], token),
      ).rejects.toMatchObject({ messageKey: 'validation.serverMaster.accountCount' });
      await expect(serverMasters.setUpMissingServerMasters([third], token)).resolves.toHaveLength(1);
      await expect(
        serverMasters.setUpMissingServerMasters([{ ...third, username: 'master-fourth' }], token),
      ).rejects.toMatchObject({ statusCode: 409, messageKey: 'error.conflict.serverMastersComplete' });
    });

    it('a recovery lifts the sign-in lockout and ends the old sessions', async () => {
      await setUpFirstRun();
      const masterPc = { onMasterPc: true };
      const { token: session } = await authService.signIn(MAIN.username, MAIN.password, undefined, masterPc);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await authService.signIn(MAIN.username, 'wrong-password', undefined, masterPc).catch(() => undefined);
      }
      await expect(authService.signIn(MAIN.username, MAIN.password, undefined, masterPc)).rejects.toMatchObject({
        messageKey: 'error.unauthorized.tooManyAttempts',
      });

      const { token } = await masterKeyGate.unlock(TEST_KEY);
      await serverMasters.recoverServerMasterPassword(await userIdOf(MAIN.username), 'recovered-pass-1', token);

      expect(await authService.resolveSession(session, '127.0.0.1')).toBeNull();
      await expect(
        authService.signIn(MAIN.username, 'recovered-pass-1', undefined, masterPc),
      ).resolves.toBeTruthy();
    });

    it('changes the pairing password for a Server Master only', async () => {
      await setUpFirstRun();
      const { token } = await masterKeyGate.unlock(TEST_KEY);

      await expect(serverMasters.changePairingPassword(await testActor(), token)).rejects.toMatchObject({
        statusCode: 403,
      });
      const { pairingPassword } = await serverMasters.changePairingPassword(await serverMasterActor(), token);
      expect(await verifyPairingPassword(pairingPassword)).toBe(true);
    });

    describe('when the closing entry cannot be written, nothing changes', () => {
      afterEach(acceptAuditEntries);

      it('setting up the missing Server Masters', async () => {
        await setUpFirstRun();
        await db()('users').where({ username: BACKUP.username }).update({ is_active: false });
        const { token } = await masterKeyGate.unlock(TEST_KEY);
        await refuseAuditEntries('server_masters_set_up');

        await expect(
          serverMasters.setUpMissingServerMasters(
            [{ username: 'master-third', displayName: 'Third', password: 'third-pass-3' }],
            token,
          ),
        ).rejects.toThrow(/audit probe/);
        expect(await db()('users').where({ username: 'master-third' }).first()).toBeUndefined();
      });

      it('changing the pairing password', async () => {
        const { pairingPassword } = await setUpFirstRun();
        const { token } = await masterKeyGate.unlock(TEST_KEY);
        await refuseAuditEntries();

        await expect(serverMasters.changePairingPassword(await serverMasterActor(), token)).rejects.toThrow(
          /audit probe/,
        );
        expect(await verifyPairingPassword(pairingPassword)).toBe(true);
      });
    });

    it('will not reveal a Server Master password to an admin', async () => {
      await setUpFirstRun();
      const admin = await testActor();
      await settingsService.writeSetting(admin, 'security.passwordRevealEnabled', true);

      await expect(
        passwordVaultService.revealPassword(await userIdOf(MAIN.username), 'any', admin, undefined),
      ).rejects.toMatchObject({ statusCode: 403, messageKey: 'error.forbidden.serverMasterTarget' });
    });
  });
});
