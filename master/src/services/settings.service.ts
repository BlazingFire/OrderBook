/**
 * The company's settings: read, written, cached and audited.
 *
 * Two read paths, deliberately different:
 *
 *  - `getSetting` is the **internal** accessor and checks no permission. The
 *    password vault reading its own on/off switch is not a user-facing read,
 *    and making it one would mean the vault could only work for callers who
 *    happened to hold `settings.manage`.
 *  - `readSettings` is what the Settings screen calls, requires
 *    `settings.manage`, and never returns a secret's value — only whether one
 *    is configured.
 *
 * The cache is per tenant and is emptied on write, not aged out by a TTL. Same
 * reason `auth.service.ts` refuses a TTL on its permission reads: a time-based
 * cache means a setting somebody just turned **off** keeps behaving as though it
 * were on for the length of the TTL, and one of these settings governs whether
 * passwords are being kept at all.
 *
 * `getSetting` falls back to the declared default on a missing row, on a
 * `parse` throw, **and on a `SecretBoxError`**. The last is not optional:
 * `settings` travels inside backups while `vault.key` does not, so a restore on
 * a new machine leaves every sealed value unopenable, and `open()` throws before
 * `parse` ever runs.
 */

import type { SettingKey, SettingValue, SettingView } from '@orderbook/shared';
import { SETTINGS, SETTING_KEYS, isSettingKey } from '@orderbook/shared';

import { actorUserId, requirePermission, type ActorContext } from '../domain/actor.js';
import { db } from '../db/knex.js';
import { ValidationError } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { CURRENT_KEY_VERSION, open, seal, SecretBoxError } from '../lib/secret-box.js';
import * as activityLog from '../repositories/activity-log.repository.js';
import { clearVault } from '../repositories/password-vault.repository.js';
import * as settingsRepo from '../repositories/settings.repository.js';
import { publishChange } from './change-bus.js';

const log = createLogger('settings');

/** Parsed values per tenant. Emptied on write, and by the test fixture's reset. */
const cache = new Map<string, Map<string, unknown>>();

export function invalidateSettingsCache(tenantId?: string): void {
  if (tenantId) cache.delete(tenantId);
  else cache.clear();
}

function aadFor(tenantId: string, key: SettingKey): string {
  return `setting:${tenantId}:${key}`;
}

function isSecretDefinition(key: SettingKey): boolean {
  const definition = SETTINGS[key];
  return 'secret' in definition && definition.secret === true;
}

/**
 * Turn one stored row into a parsed value, or the declared fallback.
 *
 * Never throws. A stored value that no longer parses — because a newer build
 * narrowed the shape, or because the key file did not come back with the
 * backup — must not take out every caller of an unrelated setting.
 */
function decode<K extends SettingKey>(tenantId: string, key: K, raw: unknown): SettingValue<K> {
  const definition = SETTINGS[key];

  try {
    const plain = isSecretDefinition(key) ? open(raw as never, aadFor(tenantId, key)) : raw;
    return definition.parse(plain) as SettingValue<K>;
  } catch (error) {
    log.warn(
      `Setting "${key}" fell back to its default: ${
        error instanceof SecretBoxError
          ? `sealed value unreadable (${error.reason})`
          : 'the stored value did not parse'
      }`,
    );
    return definition.fallback as SettingValue<K>;
  }
}

async function loadTenant(tenantId: string): Promise<Map<string, unknown>> {
  const cached = cache.get(tenantId);
  if (cached) return cached;

  const rows = await settingsRepo.readSettingRows(tenantId);
  const stored = new Map(rows.map((row) => [row.key, row.value]));

  const parsed = new Map<string, unknown>();
  for (const key of SETTING_KEYS) {
    parsed.set(
      key,
      stored.has(key) ? decode(tenantId, key, stored.get(key)) : SETTINGS[key].fallback,
    );
  }

  cache.set(tenantId, parsed);
  return parsed;
}

/** The internal accessor. No permission check — see this file's header. */
export async function getSetting<K extends SettingKey>(
  tenantId: string,
  key: K,
): Promise<SettingValue<K>> {
  const parsed = await loadTenant(tenantId);
  return parsed.get(key) as SettingValue<K>;
}

export async function readSettings(actor: ActorContext): Promise<SettingView[]> {
  requirePermission(actor, 'settings.manage');

  const rows = await settingsRepo.readSettingRows(actor.tenantId);
  const stored = new Map(rows.map((row) => [row.key, row]));

  return SETTING_KEYS.map((key): SettingView => {
    const definition = SETTINGS[key];
    const row = stored.get(key);
    const isDefault = row === undefined;
    const updatedAt = row ? row.updatedAt.toISOString() : null;
    const updatedBy = row?.updatedBy ?? null;

    if (isSecretDefinition(key)) {
      // `configured` and no `value` property at all — absent, not null. A value that cannot be opened reads as not
      // configured rather than as an error: it is unusable either way, and the
      // administrator's next move is the same one.
      let configured = false;
      if (row) {
        try {
          open(row.value as never, aadFor(actor.tenantId, key));
          configured = true;
        } catch {
          configured = false;
        }
      }

      return { key, secret: true, configured, isDefault, updatedAt, updatedBy };
    }

    return {
      key,
      secret: false,
      value: row ? decode(actor.tenantId, key, row.value) : definition.fallback,
      isDefault,
      updatedAt,
      updatedBy,
    };
  });
}

export async function writeSetting<K extends SettingKey>(
  actor: ActorContext,
  key: K,
  raw: unknown,
): Promise<void> {
  requirePermission(actor, 'settings.manage');

  // The key arrives from a URL segment, so it is checked here as well as being
  // typed — a caller naming an unknown key gets the same refusal as one naming
  // a bad value, rather than an undefined-property crash.
  if (!isSettingKey(key)) throw new ValidationError('validation.setting.invalid', { key });

  const definition = SETTINGS[key];
  const secret = isSecretDefinition(key);

  let parsed: unknown;
  try {
    parsed = definition.parse(raw);
  } catch {
    throw new ValidationError('validation.setting.invalid', { key });
  }

  const before = await getSetting(actor.tenantId, key);
  const stored = secret ? seal(String(parsed), aadFor(actor.tenantId, key)) : parsed;

  await db().transaction(async (trx) => {
    await settingsRepo.upsertSetting(
      actor.tenantId,
      key,
      stored,
      secret,
      CURRENT_KEY_VERSION,
      actorUserId(actor),
      trx,
    );

    // The one named special case. A switch that stops the display while
    // leaving the plaintexts in the database is a switch that lies, so the
    // purge belongs in the same transaction as the flag — never as a
    // best-effort follow-up a crash can skip.
    let purged: number | null = null;
    if (key === 'security.passwordRevealEnabled' && parsed === false) {
      purged = await clearVault(trx, [actor.tenantId]);
    }

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'setting',
        entityId: key,
        action: 'updated',
        actorType: actor.actorType,
        actorId: actor.actorId,
        // `String(...)` because `renderActivity` copies only strings and
        // numbers out of `details`; a raw boolean would be dropped silently.
        // A secret carries the key name and nothing else — never the value,
        // sealed or otherwise, and never its length.
        details: secret
          ? { name: key }
          : {
              name: key,
              from: String(before),
              to: String(parsed),
              ...(purged === null ? {} : { purgedPasswords: purged }),
            },
      },
      actor,
      trx,
    );
  });

  invalidateSettingsCache(actor.tenantId);

  /*
   * Tell the panels, and tell them AFTER the cache is dropped.
   *
   * Order is load-bearing: publishing first races the refresh this triggers
   * against the per-tenant cache above, and the snapshot that refresh builds
   * would be served the value that was just replaced.
   *
   * Until this existed a company switch reached a panel exactly once, on its
   * first snapshot. `inventory.freeToSell` has shipped with that: an
   * administrator flipped it, the Settings screen said so, and every panel
   * went on showing the old shape until somebody restarted it. `'setting'` is
   * in `SNAPSHOT_FORCING_ENTITIES`, so this both refreshes a connected panel
   * and refuses a reconnecting panel's delta.
   *
   * `payload: null` on purpose. The refresh is decided before anything reads
   * the payload, and a sealed setting's value must never ride the ring.
   */
  publishChange({ entity: 'setting', action: 'updated', id: key, payload: null });
}
