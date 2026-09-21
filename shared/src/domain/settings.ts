/**
 * The company's own settings, declared once.
 *
 * A row per key in the Master's `settings` table, never a column per toggle: a
 * migration per switch is what makes people stop adding switches, and a single
 * JSONB blob would give no per-key audit, no per-key secret handling, and a
 * read-modify-write race on every save.
 *
 * **An absent row means the declared `fallback`.** The migration inserts
 * nothing, so an installation behaves exactly as it did the minute before it
 * upgraded, and a key added here needs no data migration at all.
 *
 * The line between this and `localStorage`: *if two people at the same PC
 * should see it differently it is `localStorage`; if it is a decision the
 * company made once, it is a setting here.* A 4K screen is a property of the
 * desk, not of the company, so UI scale, density, theme and motion stay in the
 * browser (`ui/src/theme.ts`).
 *
 * Every setting is Master-only. There is deliberately no `audience` field and
 * no `writePermission` field: a per-setting write permission deadlocked the
 * installations it claimed to protect, because gating
 * `security.passwordRevealEnabled` on `users.viewPassword` meant an upgraded
 * installation — where nobody holds that key yet — could not turn the feature
 * on, and, worse, could not turn it **off** to purge what it had stored. Every
 * write is gated on `settings.manage` alone.
 */

import type { MessageKey } from '../i18n/keys.js';

export interface SettingDefinition<T> {
  labelToken: MessageKey;
  descriptionToken: MessageKey;
  fallback: T;
  /**
   * The single validation site for this key, on both the write path and the
   * read path — a stored value that no longer parses falls back rather than
   * poisoning every reader.
   *
   * Annotated `(raw: unknown)` at every declaration on purpose: `strict: true`
   * means `satisfies` does not contextually type a parameter through the
   * assertion, so an un-annotated `raw` would be an implicit `any`.
   */
  parse: (raw: unknown) => T;
  /**
   * Stored sealed with AES-256-GCM. The read endpoint answers
   * `{ configured: boolean }` and never the value — absent, not null, the same
   * rule masked rates follow in `visibility.ts`.
   */
  secret?: boolean;
}

function asBoolean(raw: unknown): boolean {
  if (typeof raw !== 'boolean') throw new TypeError('expected a boolean');
  return raw;
}

/**
 * Every setting the product has. Adding one is this entry, its two catalogue
 * tokens in `en.ts` and `hi.ts`, and nothing else — no migration, no column.
 */
export const SETTINGS = {
  /**
   * The load-bearing control on the password vault, and the reason the vault
   * is safe to ship at all: nothing is sealed while this is `false`, and
   * setting it back to `false` deletes every stored plaintext in the same
   * transaction. The `users.viewPassword` permission is *not* the safety
   * control — a fresh install's seeded Administrator already holds it, because
   * `20260303000000_roles_and_users.ts` grants that role a live
   * `allPermissions()`.
   */
  'security.passwordRevealEnabled': {
    labelToken: 'setting.security.passwordRevealEnabled.label',
    descriptionToken: 'setting.security.passwordRevealEnabled.help',
    fallback: false,
    parse: (raw: unknown): boolean => asBoolean(raw),
  },

  /**
   * Whether stock is split into on-hand, reserved and free to sell.
   *
   * Off by default: a counter that never reserves ahead has one number per
   * colour, the boxes on the floor, and a second and third column beside it
   * are noise. While it is off every stock figure the Master hands out reads
   * on-hand as free (`withoutReservations` in `domain/inventory-view.ts`),
   * low stock is judged on the floor count, and the screens drop the
   * reserved/free columns and the reservation panels. Orders still reserve
   * quietly underneath, so switching it back on shows the true picture.
   */
  'inventory.freeToSell': {
    labelToken: 'setting.inventory.freeToSell.label',
    descriptionToken: 'setting.inventory.freeToSell.help',
    fallback: false,
    parse: (raw: unknown): boolean => asBoolean(raw),
  },

  /**
   * The public API's master switch.
   *
   * There was a second key beside this one — a list of `{slug, label, baseUrl}`
   * declarations for outbound connections — which Stage 11 replaced with real
   * tables carrying resources, field maps, links and runs. Two homes for one
   * concept is how they drift, so the settings-level list was deleted rather
   * than left as a shadow copy nothing reads.
   */
  'externalApi.enabled': {
    labelToken: 'setting.externalApi.enabled.label',
    descriptionToken: 'setting.externalApi.enabled.help',
    fallback: false,
    parse: (raw: unknown): boolean => asBoolean(raw),
  },
} satisfies Record<string, SettingDefinition<unknown>>;

export type SettingKey = keyof typeof SETTINGS;

/** The parsed type of one key — taken from its parser, the one validation site. */
export type SettingValue<K extends SettingKey> = ReturnType<(typeof SETTINGS)[K]['parse']>;

export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

export function isSettingKey(value: unknown): value is SettingKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SETTINGS, value);
}

/** True when the key is stored sealed and must never be read back over the wire. */
export function isSecretSetting(key: SettingKey): boolean {
  return 'secret' in SETTINGS[key] && SETTINGS[key].secret === true;
}

/**
 * One setting as the Settings screen sees it.
 *
 * A secret carries **no `value` property at all** — absent rather than null,
 * because `value === null` passes against an implementation that forgot to
 * strip it.
 */
export type SettingView =
  | {
      key: SettingKey;
      secret: false;
      value: unknown;
      isDefault: boolean;
      updatedAt: string | null;
      updatedBy: string | null;
    }
  | {
      key: SettingKey;
      secret: true;
      configured: boolean;
      isDefault: boolean;
      updatedAt: string | null;
      updatedBy: string | null;
    };
