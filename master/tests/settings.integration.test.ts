/**
 * The settings table, end to end against a real database.
 *
 * Two of these are about failure modes rather than features, and they are the
 * ones worth keeping: a sealed value that cannot be opened must read as "not
 * configured" rather than taking out the whole screen, and turning the password
 * vault off must delete what it stored **in the same transaction** as the flag.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SETTING_KEYS } from '@orderbook/shared';

import { db } from '../src/db/knex.js';
import type { ActorContext } from '../src/domain/actor.js';
import { ForbiddenError, ValidationError } from '../src/lib/errors.js';
import * as settingsService from '../src/services/settings.service.js';
import { canRunIntegrationTests } from './helpers/db.js';
import {
  actorWith,
  resetData,
  setupDatabase,
  teardownDatabase,
  testActor,
} from './helpers/fixtures.js';

let admin: ActorContext;

function viewFor(views: Awaited<ReturnType<typeof settingsService.readSettings>>, key: string) {
  const found = views.find((view) => view.key === key);
  if (!found) throw new Error(`No view for ${key}`);
  return found;
}

describe.skipIf(!canRunIntegrationTests)('settings (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    admin = await testActor();
  });

  it('answers with the declared default when no row exists', async () => {
    expect(await settingsService.getSetting(admin.tenantId, 'security.passwordRevealEnabled')).toBe(
      false,
    );
    expect(await settingsService.getSetting(admin.tenantId, 'externalApi.enabled')).toBe(false);

    const views = await settingsService.readSettings(admin);
    // Counted against the catalogue rather than a literal: this list grows with
    // each stage that adds a setting, and a hard-coded number turns that into a
    // failure in a suite that is not about the new setting.
    expect(views).toHaveLength(SETTING_KEYS.length);
    expect(viewFor(views, 'security.passwordRevealEnabled')).toMatchObject({
      isDefault: true,
      value: false,
      updatedAt: null,
    });
  });

  it('refuses a caller without settings.manage, on both the read and the write', async () => {
    const clerk = await actorWith(['users.manage']);

    await expect(settingsService.readSettings(clerk)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      settingsService.writeSetting(clerk, 'security.passwordRevealEnabled', true),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('refuses a value the key cannot mean', async () => {
    await expect(
      settingsService.writeSetting(admin, 'security.passwordRevealEnabled', 'yes'),
    ).rejects.toBeInstanceOf(ValidationError);

    // …and nothing was written, so the default still stands.
    expect(await settingsService.getSetting(admin.tenantId, 'security.passwordRevealEnabled')).toBe(
      false,
    );
  });

  it('makes two consecutive writes visible immediately, with no read in between', async () => {
    await settingsService.writeSetting(admin, 'externalApi.enabled', true);
    expect(await settingsService.getSetting(admin.tenantId, 'externalApi.enabled')).toBe(true);

    await settingsService.writeSetting(admin, 'externalApi.enabled', false);
    expect(await settingsService.getSetting(admin.tenantId, 'externalApi.enabled')).toBe(false);
  });

  it('falls back to the default when a stored value no longer parses, rather than throwing', async () => {
    // Store a real value, then corrupt it in place, the
    // way a narrowed parser in a newer build would find an older value.
    await settingsService.writeSetting(admin, 'externalApi.enabled', true);
    await db()('settings')
      .where({ tenant_id: admin.tenantId, key: 'externalApi.enabled' })
      .update({ value: JSON.stringify('yes') });
    settingsService.invalidateSettingsCache();

    expect(await settingsService.getSetting(admin.tenantId, 'externalApi.enabled')).toBe(false);
    expect(viewFor(await settingsService.readSettings(admin), 'externalApi.enabled')).toMatchObject({
      value: false,
      isDefault: false,
    });
  });

  it('deletes every stored password in the same transaction as switching the vault off', async () => {
    await settingsService.writeSetting(admin, 'security.passwordRevealEnabled', true);

    await db()('user_password_vault').insert({
      tenant_id: admin.tenantId,
      user_id: 'US0000000001',
      sealed: JSON.stringify({ v: 1, iv: 'AAAA', tag: 'AAAA', ct: 'AAAA' }),
      credential_fingerprint: 'deadbeefdeadbeef',
      key_version: 1,
    });

    await settingsService.writeSetting(admin, 'security.passwordRevealEnabled', false);

    const remaining = await db()('user_password_vault').count<{ count: string }>({ count: '*' }).first();
    expect(Number(remaining?.count ?? -1)).toBe(0);
  });

  it('audits every write, naming the key and both values', async () => {
    await settingsService.writeSetting(admin, 'externalApi.enabled', true);
    await settingsService.writeSetting(admin, 'leads.packagingRequiredOnConvert', true);

    const rows = await db()('activity_log')
      .where({ tenant_id: admin.tenantId, entity_type: 'setting' })
      .orderBy('created_at')
      .select<Array<{ entity_id: string; action: string; details: Record<string, unknown> }>>(
        'entity_id',
        'action',
        'details',
      );

    expect(rows.map((row) => `${row.entity_id}:${row.action}`)).toEqual([
      'externalApi.enabled:updated',
      'leads.packagingRequiredOnConvert:updated',
    ]);

    // `labelToken` and a switch's `fromToken` / `toToken` are message keys the
    // Logs sentence translates; `from` / `to` stay the raw values.
    expect(rows[0]?.details).toEqual({
      name: 'externalApi.enabled',
      labelToken: 'setting.externalApi.enabled.label',
      from: 'false',
      to: 'true',
      fromToken: 'settingValue.off',
      toToken: 'settingValue.on',
    });
    expect(rows[1]?.details).toEqual({
      name: 'leads.packagingRequiredOnConvert',
      labelToken: 'setting.leads.packagingRequiredOnConvert.label',
      from: 'false',
      to: 'true',
      fromToken: 'settingValue.off',
      toToken: 'settingValue.on',
    });
  });
});
