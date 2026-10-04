/**
 * Two panels with the same name cannot be told apart on the screen an administrator
 * uses to decide which PC to revoke or walk to (Connection audit M9, M10): a PC that is
 * reinstalled pairs again under the name its user types while the old row is still
 * listed. A name nobody in use has is kept; a taken one gets a number.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setUpFirstRun, setupDatabase, teardownDatabase, testActor, testTenantId } from './helpers/fixtures.js';
import { db } from '../src/db/knex.js';
import * as panels from '../src/services/panel.service.js';

describe('nameIsTaken / uniquePanelName', () => {
  it('ignores case and surrounding spaces, and counts up past a number already used', () => {
    expect(panels.nameIsTaken('  reception ', ['Reception'])).toBe(true);
    expect(panels.nameIsTaken('Reception', ['Reception 2'])).toBe(false);
    expect(panels.uniquePanelName('Reception', [])).toBe('Reception');
    expect(panels.uniquePanelName('Reception', ['Reception'])).toBe('Reception 2');
    expect(panels.uniquePanelName('Reception', ['reception', 'Reception 2'])).toBe('Reception 3');
  });
});

describe.skipIf(!canRunIntegrationTests)('pairing again (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);

  beforeEach(async () => {
    await resetData();
    panels.closePairingWindow();
    await setUpFirstRun('Shree Ceramics');
  });

  async function pairAs(name: string, hostname: string) {
    panels.openPairingWindow();
    const paired = await panels.pairPanel({ mode: 'auto', panelName: name, hostname }, '192.168.1.20');
    await db()('office_panels').where({ id: paired.panelId }).update({ hostname });
    return paired;
  }
  const rows = () => db()('office_panels').select('id', 'name', 'status', 'device_code');

  it('gives a removed PC its old row back, with a new secret, instead of a second row (Connection B4)', async () => {
    const first = await pairAs('Reception', 'FRONT-PC');
    await panels.revokePanel(first.panelId, await testActor());

    const again = await pairAs('Reception', 'front-pc');

    expect(again.panelId).toBe(first.panelId);
    expect(again.panelSecret).not.toBe(first.panelSecret);
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ name: 'Reception', status: 'active' });
    await expect(panels.authenticatePanel(first.panelId, again.panelSecret)).resolves.toMatchObject({ id: first.panelId });
    await expect(panels.authenticatePanel(first.panelId, first.panelSecret)).rejects.toThrow();
  });

  it('does the same for a reinstalled PC whose old row was never removed, but not for another PC with the same name', async () => {
    const first = await pairAs('Counter', 'COUNTER-PC');
    expect((await pairAs('Counter', 'COUNTER-PC')).panelId).toBe(first.panelId);
    const other = await pairAs('Counter', 'OTHER-PC');
    expect(other.panelId).not.toBe(first.panelId);
    expect(await rows()).toHaveLength(2);
  });

  it('leaves a PC alone that is connected right now', async () => {
    const first = await pairAs('Counter', 'COUNTER-PC');
    await panels.markPanelConnected(first.panelId, '192.168.1.20', 8);
    try {
      const second = await pairAs('Counter', 'COUNTER-PC');
      expect(second.panelId).not.toBe(first.panelId);
      await expect(panels.authenticatePanel(first.panelId, first.panelSecret)).resolves.toBeDefined();
    } finally {
      await panels.markPanelDisconnected(first.panelId);
    }
  });
});

describe.skipIf(!canRunIntegrationTests)('pairing names (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);

  beforeEach(async () => {
    await resetData();
    panels.closePairingWindow();
    await setUpFirstRun('Shree Ceramics');
  });

  async function pair(name: string) {
    panels.openPairingWindow();
    const paired = await panels.pairPanel({ mode: 'auto', panelName: name, hostname: 'pc1' }, '192.168.1.20');
    const row = await db()('office_panels').where({ id: paired.panelId }).first();
    return { paired, name: String(row.name) };
  }

  it('numbers a second panel that asks for a name in use', async () => {
    expect((await pair('Reception')).name).toBe('Reception');
    expect((await pair('reception')).name).toBe('reception 2');
  });

  it('lets a name be used again once its panel was removed', async () => {
    const first = await pair('Reception');
    await panels.revokePanel(first.paired.panelId, await testActor());
    expect((await pair('Reception')).name).toBe('Reception');
  });

  it('refuses to rename a panel to a name another one in use has, but not to its own', async () => {
    const a = await pair('Reception');
    const b = await pair('Counter');
    await expect(panels.renamePanel(b.paired.panelId, 'reception', await testActor())).rejects.toThrow(/already/i);
    await expect(panels.renamePanel(a.paired.panelId, 'Reception', await testActor())).resolves.toBeDefined();
    expect(await testTenantId()).toBeTruthy();
  });
});
