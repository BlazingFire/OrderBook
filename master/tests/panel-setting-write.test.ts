/**
 * `settings:save` from an Office panel: a signed-in person, and the one key
 * the Settings → Leads tab edits (`docs/catalogue/CATALOGUE_MODEL.md` §5).
 *
 * The panel actor falls back to the panel's own role when no user token is
 * accepted, so a panel holding an admin-tier role would otherwise lend
 * `settings.manage` to whoever sits at it — and the forward would reach the
 * password-vault purge and the public API switch. Pure: the guard runs before
 * the service touches the database.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SETTING_KEYS } from '@orderbook/shared';
import { describe, expect, it } from 'vitest';

import type { ActorContext } from '../src/domain/actor.js';
import { ForbiddenError, ValidationError } from '../src/lib/errors.js';
import { assertPanelSettingWrite } from '../src/realtime/hub.js';

const person: ActorContext = {
  tenantId: 'TN1',
  actorType: 'user',
  actorId: 'US1',
  userId: 'US1',
  permissions: {
    roleId: 'RL1',
    roleName: 'Admin',
    tier: 'admin',
    permissions: ['settings.manage'],
  },
  deviceCode: 'K7M2QX',
  actorName: 'Kiran',
};

/** What `resolvePanelActor` returns with no accepted token: the panel's own role. */
const panelFallback: ActorContext = {
  ...person,
  actorType: 'office_panel',
  actorId: 'PN1',
  userId: null,
  actorName: null,
};

describe('assertPanelSettingWrite', () => {
  it('lets a signed-in person write the lead follow-up default', () => {
    expect(() => assertPanelSettingWrite(person, 'leads.followUpDefaultDays')).not.toThrow();
  });

  it("refuses the panel's own role even when it holds settings.manage", () => {
    expect(() => assertPanelSettingWrite(panelFallback, 'leads.followUpDefaultDays')).toThrow(
      ForbiddenError,
    );
  });

  it.each(SETTING_KEYS.filter((key) => key !== 'leads.followUpDefaultDays'))(
    'refuses %s, which is the Master screen’s alone',
    (key) => {
      expect(() => assertPanelSettingWrite(person, key)).toThrow(ValidationError);
    },
  );

  it('refuses a key that is not a setting at all', () => {
    expect(() => assertPanelSettingWrite(person, 'leads.')).toThrow(ValidationError);
    expect(() => assertPanelSettingWrite(person, undefined)).toThrow(ValidationError);
  });
});

/*
 * Every case above still passes if the handler stops calling the guard, and
 * there is no socket harness for the hub to prove it through. So this reads the
 * source, as `credential-invariants.test.ts` does for its greppable rules.
 */
describe('the settings:save handler', () => {
  const hub = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'realtime', 'hub.ts'),
    'utf8',
  );

  it('runs the guard before the write, and is the hub’s only way to a setting', () => {
    const start = hub.indexOf("socket.on('settings:save'");
    expect(start).toBeGreaterThan(-1);
    const handler = hub.slice(start, hub.indexOf('socket.on(', start + 1));

    const guard = handler.indexOf('assertPanelSettingWrite(actor, key);');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(handler.indexOf('settingsService.writeSetting('));
    // A second handler writing settings would be a second door with no guard.
    expect(hub.split('writeSetting(').length - 1).toBe(1);
  });
});
