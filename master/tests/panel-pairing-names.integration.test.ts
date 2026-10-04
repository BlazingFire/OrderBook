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

  it('still needs a valid pairing: a matching machine name alone gets nothing, and the entry names the row it replaced', async () => {
    const first = await pairAs('Reception', 'FRONT-PC');
    await panels.revokePanel(first.panelId, await testActor());

    panels.closePairingWindow();
    await expect(
      panels.pairPanel({ mode: 'auto', panelName: 'Reception', hostname: 'FRONT-PC' }, '192.168.1.20'),
    ).rejects.toThrow(/not accepting/i);
    await expect(
      panels.pairPanel({ mode: 'manual', panelName: 'Reception', hostname: 'FRONT-PC', pairingPassword: 'wrong' }, '192.168.1.20'),
    ).rejects.toThrow(/pairing password/i);
    expect((await rows())[0]).toMatchObject({ status: 'revoked' });

    await pairAs('Reception', 'FRONT-PC');
    const entry = await db()('activity_log').where({ entity_id: first.panelId, action: 're_paired' }).first();
    expect(entry).toBeTruthy();
    expect(JSON.stringify(entry.details)).toContain('"previousStatus":"removed"');
    expect(JSON.stringify(entry.details)).toContain(first.panelId);
  });

  it('a panel that leaves leaves a removed row behind, once, with an entry saying so', async () => {
    const first = await pairAs('Counter', 'COUNTER-PC');
    await panels.leavePanel(first.panelId);
    await panels.leavePanel(first.panelId);
    expect((await rows())[0]).toMatchObject({ status: 'revoked' });
    const entries = await db()('activity_log').where({ entity_id: first.panelId, action: 'left' });
    expect(entries).toHaveLength(1);
    // And it gets the row back when it pairs again.
    expect((await pairAs('Counter', 'COUNTER-PC')).panelId).toBe(first.panelId);
  });

  it('replaces an ACTIVE row only for the PC that proves it owns it with the id and the secret, and never stores or echoes the secret', async () => {
    const first = await pairAs('Counter', 'COUNTER-PC');

    // Id with a wrong secret: a new panel, the old one untouched.
    panels.openPairingWindow();
    const wrong = await panels.pairPanel(
      { mode: 'auto', panelName: 'Till', hostname: 'OTHER-PC', previousPanelId: first.panelId, previousPanelSecret: 'not-the-secret' },
      null,
    );
    expect(wrong.panelId).not.toBe(first.panelId);
    await expect(panels.authenticatePanel(first.panelId, first.panelSecret)).resolves.toBeDefined();

    // Id and the right secret: the same row, a new secret, the old one dead.
    panels.openPairingWindow();
    const owner = await panels.pairPanel(
      { mode: 'auto', panelName: 'Counter', hostname: 'RENAMED-PC', previousPanelId: first.panelId, previousPanelSecret: first.panelSecret },
      null,
    );
    expect(owner.panelId).toBe(first.panelId);
    await expect(panels.authenticatePanel(first.panelId, first.panelSecret)).rejects.toThrow();
    await expect(panels.authenticatePanel(first.panelId, owner.panelSecret)).resolves.toBeDefined();

    // The secret is in no row of the trail.
    const trail = JSON.stringify(await db()('activity_log').select('details'));
    expect(trail).not.toContain(first.panelSecret);
    expect(trail).not.toContain('previousPanelSecret');
  });

  it('gives a PC that proves an active row with its secret that row, not a removed one that shares its machine name', async () => {
    const removedOne = await pairAs('Old', 'SHARED-PC');
    await panels.revokePanel(removedOne.panelId, await testActor());
    const active = await pairAs('Counter', 'COUNTER-PC');

    panels.openPairingWindow();
    const result = await panels.pairPanel(
      { mode: 'auto', panelName: 'Counter', hostname: 'SHARED-PC', previousPanelId: active.panelId, previousPanelSecret: active.panelSecret },
      null,
    );

    expect(result.panelId).toBe(active.panelId);
    expect((await db()('office_panels').where({ id: removedOne.panelId }).first()).status).toBe('revoked');
  });

  it('numbers a the name of a revived row when another panel in use took it while the row was removed', async () => {
    const first = await pairAs('Counter', 'COUNTER-PC');
    await panels.revokePanel(first.panelId, await testActor());
    expect((await pairAs('Counter', 'NEW-PC')).panelId).not.toBe(first.panelId);

    const again = await pairAs('Counter', 'COUNTER-PC');

    expect(again.panelId).toBe(first.panelId);
    const names = (await rows()).map((row) => String(row.name)).sort();
    expect(names).toEqual(['Counter', 'Counter 2']);
    expect((await db()('office_panels').where({ id: first.panelId }).first()).name).toBe('Counter 2');
  });

  it('prefers a verified active row, then the removed row it names, then a removed row with its machine name', async () => {
    const byHost = await pairAs('Host match', 'SHARED-PC');
    await panels.revokePanel(byHost.panelId, await testActor());
    const named = await pairAs('Named', 'OTHER-PC');
    await panels.revokePanel(named.panelId, await testActor());

    // Both removed rows could match; the one it names wins over the machine name.
    panels.openPairingWindow();
    const result = await panels.pairPanel(
      { mode: 'auto', panelName: 'x', hostname: 'SHARED-PC', previousPanelId: named.panelId },
      null,
    );
    expect(result.panelId).toBe(named.panelId);
  });

  it('never takes over a row that is not removed: a reinstalled PC with its old row still active joins as a new panel', async () => {
    const first = await pairAs('Counter', 'COUNTER-PC');
    const second = await pairAs('Counter', 'COUNTER-PC');
    expect(second.panelId).not.toBe(first.panelId);
    expect((await rows()).map((row) => row.name).sort()).toEqual(['Counter', 'Counter 2']);
    // The first is untouched: its secret still works.
    await expect(panels.authenticatePanel(first.panelId, first.panelSecret)).resolves.toBeDefined();
  });

  it('gives the row back to the PC that names it, even under another machine name, and not to a different PC', async () => {
    const first = await pairAs('Counter', 'COUNTER-PC');
    await panels.revokePanel(first.panelId, await testActor());

    panels.openPairingWindow();
    const other = await panels.pairPanel({ mode: 'auto', panelName: 'Till', hostname: 'OTHER-PC' }, '192.168.1.21');
    expect(other.panelId).not.toBe(first.panelId);

    panels.openPairingWindow();
    const named = await panels.pairPanel(
      { mode: 'auto', panelName: 'Counter', hostname: 'RENAMED-PC', previousPanelId: first.panelId },
      '192.168.1.20',
    );
    expect(named.panelId).toBe(first.panelId);
  });

  it('ignores a previous id that is not a removed panel of this company', async () => {
    const live = await pairAs('Counter', 'COUNTER-PC');
    panels.openPairingWindow();
    const again = await panels.pairPanel(
      { mode: 'auto', panelName: 'Till', hostname: 'OTHER-PC', previousPanelId: live.panelId },
      '192.168.1.21',
    );
    expect(again.panelId).not.toBe(live.panelId);
    panels.openPairingWindow();
    const junk = await panels.pairPanel({ mode: 'auto', panelName: 'Till', hostname: 'X', previousPanelId: 'not-a-uuid' }, null);
    expect(junk.panelId).toBeTruthy();
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
