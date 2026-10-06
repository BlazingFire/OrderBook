/**
 * Rule 4: every business, settings, user, security, panel, export and backup
 * operation leaves an entry in the trail (docs/plans/1.3-BATCH.md, Phase 2,
 * "Audit sweep"). One case per operation the sweep added, each checking the
 * entry exists, carries the details its sentence needs, and renders with no
 * placeholder left over.
 *
 * Not here, and why:
 *  - the developer reset (`developer.data_erased`) drops and rebuilds the whole
 *    schema, which this shared test cluster cannot afford mid-run;
 *  - the Master update (`master_update.install_started`) needs a releases
 *    folder read at import time, so `updates.test.ts` covers it with a fake
 *    trail;
 *  - sign-out, expiry and offline sign-ins are in `audit-trail` and
 *    `server-master`.
 *
 * The master key is never in a test: the gate is swapped for one that checks a
 * test-only key, as in `server-master.integration.test.ts`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  allPermissions,
  createTranslator,
  initialHlcState,
  renderActivity,
  tickHlc,
  type Mutation,
} from '@orderbook/shared';

import { canRunIntegrationTests } from './helpers/db.js';
import {
  createTestProduct,
  FIRST_RUN_ACCOUNTS,
  resetData,
  setUpFirstRun,
  setupDatabase,
  teardownDatabase,
  testActor,
} from './helpers/fixtures.js';
import type { ActorContext } from '../src/domain/actor.js';
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
const { hashPassword } = await import('../src/lib/password.js');
const { panelLink, setPanelLink } = await import('../src/realtime/panel-link.js');
const { exportBackup } = await import('../src/services/backup-export.service.js');
const { restoreBackup } = await import('../src/services/backup-restore.service.js');
const catalog = await import('../src/services/catalog.service.js');
const conflicts = await import('../src/services/conflict.service.js');
const developer = await import('../src/services/developer.service.js');
const leads = await import('../src/services/lead.service.js');
const logs = await import('../src/services/log.service.js');
const { createMasterKeyGate, verifyMasterKey } = await import('../src/services/master-key.service.js');
const orders = await import('../src/services/order.service.js');
const panels = await import('../src/services/panel.service.js');
const productImport = await import('../src/services/product-import.service.js');
const serverMasters = await import('../src/services/server-master.service.js');
const settings = await import('../src/services/settings.service.js');
const sync = await import('../src/services/sync.service.js');

/** Test-only; the real key is in docs/MASTER_KEY.md and nowhere else. */
const TEST_KEY = 'test-master-key-for-audit-coverage';
const PANEL = 'A3F9K2';
const PASSPHRASE = 'a-long-enough-backup-passphrase';
const en = createTranslator('en');

let actor: ActorContext;
let testKeyHash: string;

interface Entry {
  entity_type: string;
  entity_id: string;
  action: string;
  actor_id: string | null;
  actor_name: string | null;
  details: Record<string, unknown> | null;
}

async function entries(where: Record<string, unknown>): Promise<Entry[]> {
  return db()('activity_log')
    .where(where)
    .orderBy('id')
    .select<Entry[]>('entity_type', 'entity_id', 'action', 'actor_id', 'actor_name', 'details');
}

/** The one entry matching `where`; fails when there is none or more than one. */
async function onlyEntry(where: Record<string, unknown>): Promise<Entry> {
  const found = await entries(where);
  expect(found, JSON.stringify(where)).toHaveLength(1);
  return found[0] as Entry;
}

function rendered(entry: Entry, t = en): string {
  return renderActivity(t, {
    entityType: entry.entity_type,
    action: entry.action,
    actorName: entry.actor_name,
    details: entry.details,
  });
}

function hlcFor(offsetMs: number): string {
  return tickHlc(initialHlcState(PANEL), Date.now() + offsetMs).hlc;
}

async function seedLead(partyName = 'Coverage Traders') {
  const party = await catalog.createParty({ name: partyName }, actor);
  const { product, variant } = await createTestProduct(actor, { name: 'Coverage Basin', code: 'COV-1' });
  const lead = await leads.createLead(
    {
      partyId: party.id,
      items: [{ productId: product.id, variantId: variant.id, quantity: 4, packaging: 'carton' }],
    },
    actor,
  );
  return { party, product, variant, lead };
}

/** An offline edit of the lead's lines that loses to the Master's newer one, leaving one open conflict. */
async function seedConflict() {
  const { lead, product, variant } = await seedLead();
  await leads.updateLead(
    lead.id,
    { items: [{ productId: product.id, variantId: variant.id, quantity: 9, packaging: 'carton' }] },
    actor,
  );

  const mutation: Mutation = {
    mutationId: `m-${Math.random().toString(36).slice(2)}`,
    kind: 'lead.update',
    entity: 'lead',
    entityId: lead.id,
    hlc: hlcFor(-600_000),
    deviceCode: PANEL,
    fields: ['items'],
    payload: { items: [{ productId: product.id, variantId: variant.id, quantity: 1, packaging: 'carton' }] },
    baseFieldHlc: {},
    actorUserId: null,
    createdAt: new Date().toISOString(),
  };
  await sync.applyPush({ mutations: [mutation] }, await testActor({ deviceCode: PANEL, actorType: 'office_panel' }));

  const [conflict] = await conflicts.listConflicts(actor);
  if (!conflict) throw new Error('The stale push raised no conflict');
  return { lead, conflict };
}

function serverMasterActor(): Promise<ActorContext> {
  return testActor({
    permissions: { roleId: null, roleName: 'Server Master', tier: 'server_master', permissions: allPermissions() },
  });
}

describe.skipIf(!canRunIntegrationTests)('every audited operation leaves an entry (integration)', () => {
  beforeAll(async () => {
    await setupDatabase();
    testKeyHash = await hashPassword(TEST_KEY);
  });
  afterAll(teardownDatabase);

  beforeEach(async () => {
    await resetData();
    panels.closePairingWindow();
    keys.gate = createMasterKeyGate({ passwordHash: testKeyHash });
    actor = await testActor();
  });

  describe('pending and final orders', () => {
    it('a remark on a pending order', async () => {
      const { lead } = await seedLead();
      await leads.addRemark({ id: lead.id, message: 'Call back on Monday' }, actor);

      const entry = await onlyEntry({ entity_type: 'lead', entity_id: lead.id, action: 'remark_added' });
      expect(entry.details).toMatchObject({ text: 'Call back on Monday' });
      expect(rendered(entry)).toBe('Test Actor added a remark on this pending order');
    });

    it('deleting and restoring a pending order names its number and party', async () => {
      const { lead } = await seedLead();
      await leads.deleteLead(lead.id, actor);
      await leads.restoreLead(lead.id, actor);

      const deleted = await onlyEntry({ entity_type: 'lead', entity_id: lead.id, action: 'deleted' });
      const restored = await onlyEntry({ entity_type: 'lead', entity_id: lead.id, action: 'restored' });
      // Named by its PO number, as every screen names it.
      const number = lead.poNumber;
      expect(number).toMatch(/^PO\//);
      expect(deleted.details).toEqual({ number, party: 'Coverage Traders' });
      expect(rendered(deleted)).toBe(`Test Actor deleted the pending order ${number} for Coverage Traders`);
      expect(rendered(restored)).toBe(`Test Actor restored the pending order ${number} for Coverage Traders`);
    });

    it('converting records lead.converted on the lead, beside order.created', async () => {
      const { lead } = await seedLead();
      const order = await orders.convertLead({ leadId: lead.id }, actor);

      const converted = await onlyEntry({ entity_type: 'lead', entity_id: lead.id, action: 'converted' });
      expect(converted.details).toMatchObject({ orderId: order.id });
      expect(rendered(converted)).toBe('Test Actor converted this pending order into a final order');
      await onlyEntry({ entity_type: 'order', entity_id: order.id, action: 'created' });
    });

    it('deleting and restoring a final order names its number and party', async () => {
      const { lead } = await seedLead();
      const order = await orders.convertLead({ leadId: lead.id }, actor);
      await orders.deleteOrder(order.id, actor);
      await orders.restoreOrder(order.id, actor);

      const deleted = await onlyEntry({ entity_type: 'order', entity_id: order.id, action: 'deleted' });
      const restored = await onlyEntry({ entity_type: 'order', entity_id: order.id, action: 'restored' });
      // A final order shows its pending order's PO number.
      const number = order.poNumber;
      expect(number).toBe(lead.poNumber);
      expect(deleted.details).toEqual({ number, party: 'Coverage Traders' });
      expect(rendered(deleted)).toBe(`Test Actor deleted the final order ${number} for Coverage Traders`);
      expect(rendered(restored)).toBe(`Test Actor restored the final order ${number} for Coverage Traders`);
    });
  });

  describe('sync conflicts', () => {
    it('keeping the current value is logged on the conflicted record', async () => {
      const { lead, conflict } = await seedConflict();
      await conflicts.resolveConflict({ conflictId: conflict.id, action: 'keepWinner' }, actor);

      const entry = await onlyEntry({ entity_type: 'lead', entity_id: lead.id, action: 'conflict_kept' });
      expect(entry.details).toEqual({ field: 'items', conflictId: String(conflict.id) });
      expect(rendered(entry)).toBe(
        'Test Actor kept the current value after a sync conflict on this pending order',
      );
    });

    it('restoring the overwritten value is logged on the conflicted record', async () => {
      const { lead, conflict } = await seedConflict();
      await conflicts.resolveConflict({ conflictId: conflict.id, action: 'restoreLoser' }, actor);

      const entry = await onlyEntry({ entity_type: 'lead', entity_id: lead.id, action: 'conflict_restored' });
      expect(entry.details).toMatchObject({ field: 'items' });
      expect(rendered(entry)).toBe(
        'Test Actor restored the overwritten value after a sync conflict on this pending order',
      );
    });
  });

  describe('office panels', () => {
    it('the pairing window, a disconnect and a revoke are each logged', async () => {
      await setUpFirstRun('Coverage Co');
      panels.openPairingWindow();
      const paired = await panels.pairPanel({ mode: 'auto', panelName: 'Front Desk', hostname: 'pc1' }, null);

      await panels.openPairingWindowBy(actor);
      await panels.closePairingWindowBy(actor);
      const opened = await onlyEntry({ entity_type: 'pairing_window', action: 'opened' });
      expect(opened.details).toEqual({ minutes: 5 });
      expect(rendered(opened)).toBe('Test Actor opened the pairing window');
      expect(rendered(await onlyEntry({ entity_type: 'pairing_window', action: 'closed' }))).toBe(
        'Test Actor closed the pairing window',
      );

      // No hub in this suite: a link that reports the socket as dropped.
      const previous = panelLink();
      setPanelLink({
        isConnected: () => true,
        request: () => Promise.reject(new Error('not in this suite')),
        disconnect: () => true,
        notify: () => true,
      });
      try {
        expect(await panels.disconnectPanelByAdmin(paired.panelId, actor)).toBe(true);
      } finally {
        setPanelLink(previous);
      }
      const disconnected = await onlyEntry({ entity_type: 'office_panel', action: 'disconnected' });
      expect(rendered(disconnected)).toBe('Test Actor disconnected the office panel Front Desk');

      // A panel with no live socket is not "disconnected", so nothing is logged.
      expect(await panels.disconnectPanelByAdmin(paired.panelId, actor)).toBe(false);
      expect(await entries({ entity_type: 'office_panel', action: 'disconnected' })).toHaveLength(1);

      await panels.revokePanel(paired.panelId, actor);
      const revoked = await onlyEntry({ entity_type: 'office_panel', action: 'revoked' });
      expect(revoked.details).toMatchObject({ status: 'revoked' });
      expect(rendered(revoked)).toBe('Test Actor revoked the office panel Front Desk');
    });
  });

  describe('developer mode', () => {
    it('a wrong password, an unlock and a lock are each logged once', async () => {
      const gate = developer.createDeveloperGate({
        passwordHash: await hashPassword('developer-test-pass'),
        overridePassword: () => undefined,
      });

      await expect(developer.unlockDeveloper('wrong', actor, gate)).rejects.toMatchObject({ code: 'unauthorized' });
      const { token } = await developer.unlockDeveloper('developer-test-pass', actor, gate);
      await developer.lockDeveloper(token, actor, gate);
      // The token is gone, so a second lock locks nothing and logs nothing.
      await developer.lockDeveloper(token, actor, gate);

      const logged = await entries({ entity_type: 'developer' });
      expect(logged.map((entry) => entry.action)).toEqual(['unlock_failed', 'unlocked', 'locked']);
      expect(logged.map((entry) => rendered(entry))).toEqual([
        'Test Actor entered a wrong developer password',
        'Test Actor unlocked developer mode',
        'Test Actor locked developer mode',
      ]);
    });

    it('seeding the test accounts is one entry for the run', async () => {
      await setUpFirstRun('Coverage Co');
      const result = await developer.seedDummyUsers(actor);

      const entry = await onlyEntry({ entity_type: 'developer', action: 'dummy_users_seeded' });
      expect(entry.details).toEqual({ count: result.users.length });
    });
  });

  describe('exports and backups', () => {
    it('a product export', async () => {
      await createTestProduct(actor, { name: 'Exported Basin', code: 'EXP-1' });
      await productImport.exportProducts('csv', actor);
      const products = await onlyEntry({ entity_type: 'catalog', action: 'exported' });
      expect(products.details).toMatchObject({ count: 1, level: 'sub', format: 'csv' });
      expect(rendered(products)).toBe('Test Actor exported the product list, 1 rows');
    });

    it('a backup export, and its restore written into the restored trail', async () => {
      await setUpFirstRun('Coverage Co');
      const { data } = await exportBackup({ scope: 'whole', passphrase: PASSPHRASE }, actor);
      const exported = await onlyEntry({ entity_type: 'backup', action: 'exported' });
      expect(exported.details).toMatchObject({ scope: 'whole' });

      await restoreBackup(data, PASSPHRASE, true, actor);

      // The backup was made before its own export entry, so the restored trail
      // holds no export entry, and exactly one restore entry.
      expect(await entries({ entity_type: 'backup', action: 'exported' })).toHaveLength(0);
      const restored = await onlyEntry({ entity_type: 'backup', action: 'restored' });
      expect(restored).toMatchObject({ actor_id: null, actor_name: 'Test Actor' });
      expect(rendered(restored)).toBe('Test Actor restored a backup');
    });
  });

  describe('settings and the log export', () => {
    it('a switch change names the setting and its old and new state, in either language', async () => {
      await settings.writeSetting(actor, 'security.offlineSignInEnabled', false);

      const entry = await onlyEntry({ entity_type: 'setting', entity_id: 'security.offlineSignInEnabled' });
      expect(entry.details).toMatchObject({
        name: 'security.offlineSignInEnabled',
        labelToken: 'setting.security.offlineSignInEnabled.label',
        from: 'true',
        to: 'false',
        fromToken: 'settingValue.on',
        toToken: 'settingValue.off',
      });
      expect(rendered(entry)).toBe(
        'Test Actor changed Allow signing in while the Master Panel is off from On to Off',
      );

      const { csv } = await logs.exportLogs({ entityType: 'setting' }, actor);
      const [header, row] = csv.trim().split('\r\n');
      expect(header).toBe(
        'id,sequence,createdAt,actorType,actorName,entityType,entityId,action,hash,sentence,details',
      );
      expect(row).toContain('Test Actor changed Allow signing in while the Master Panel is off from On to Off');
      expect(row).toContain('""labelToken"":""setting.security.offlineSignInEnabled.label""');
    });
  });

  describe('the master key and Server Master accounts', () => {
    it('a wrong key and a right key are both logged, as the Master PC', async () => {
      await setUpFirstRun('Coverage Co');
      await expect(verifyMasterKey('not the key', null)).rejects.toMatchObject({ code: 'unauthorized' });
      await verifyMasterKey(TEST_KEY, null);

      const logged = await entries({ entity_type: 'master_key' });
      expect(logged.map((entry) => entry.action)).toEqual(['failed', 'verified']);
      expect(rendered(logged[1] as Entry)).toBe('Master PC entered the master key');
    });

    it('setup, the upgrade flow, a recovery and a pairing password change are each logged', async () => {
      await setUpFirstRun('Coverage Co');
      await onlyEntry({ entity_type: 'master_config', action: 'set_up' });

      // An installation upgraded with one Server Master short.
      await db()('users').where({ username: FIRST_RUN_ACCOUNTS[1]!.username }).update({ is_active: false });
      const { token } = await verifyMasterKey(TEST_KEY, null);

      await serverMasters.setUpMissingServerMasters(
        [{ username: 'master-third', displayName: 'Third Server Master', password: 'third-pass-3' }],
        token,
      );
      const setUp = await onlyEntry({ entity_type: 'user', action: 'server_masters_set_up' });
      expect(rendered(setUp)).toBe('Master PC set up the Server Master accounts Third Server Master');

      const main = await db()('users').where({ username: FIRST_RUN_ACCOUNTS[0]!.username }).first<{ id: string }>('id');
      await serverMasters.recoverServerMasterPassword(main!.id, 'recovered-pass-1', token);
      const recovered = await onlyEntry({ entity_type: 'user', action: 'password_recovered' });
      expect(rendered(recovered)).toBe(
        `Master PC reset the password for ${FIRST_RUN_ACCOUNTS[0]!.displayName} with the master key`,
      );

      await serverMasters.changePairingPassword(await serverMasterActor(), token);
      await onlyEntry({ entity_type: 'master_config', action: 'pairing_password_changed' });
    });

    it('the Logs list tells a Server Master’s rows apart by tier', async () => {
      await setUpFirstRun('Coverage Co');
      const main = await db()('users').where({ username: FIRST_RUN_ACCOUNTS[0]!.username }).first<{ id: string }>('id');
      const asMaster = await testActor({ actorId: main!.id, userId: main!.id, actorName: 'Main Server Master' });

      await catalog.createParty({ name: 'Tiered Traders' }, asMaster);
      await catalog.createParty({ name: 'Untiered Traders' }, actor);

      const page = await logs.listLogs({ entityType: 'party' }, actor);
      const byName = new Map(page.items.map((item) => [item.details.name, item.actor]));
      expect(byName.get('Tiered Traders')?.tier).toBe('server_master');
      // No user behind the test actor, so no tier.
      expect(byName.get('Untiered Traders')?.tier).toBeUndefined();
    });
  });
});
