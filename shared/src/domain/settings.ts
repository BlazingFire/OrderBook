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

/**
 * Which heading a setting sits under on the Settings screen.
 *
 * Deliberately declared rather than derived from the key's first segment: with
 * fifteen settings that would give six groups, three of them singletons, which is
 * worse than no grouping at all. These names are the ones a shopkeeper would
 * use over the phone, not the module names the keys are built from.
 */
export const SETTING_GROUPS = ['access', 'stock', 'leads', 'integrations'] as const;
export type SettingGroup = (typeof SETTING_GROUPS)[number];

/**
 * What the Settings screen renders for a setting, declared here rather than
 * sniffed from the value's type.
 *
 * `CompanySetting` used to branch on `typeof setting.value`, with a final
 * `else` that printed `JSON.stringify(value)` beside the words "edited
 * elsewhere" — pointing at a screen that does not exist. It was unreachable
 * while every setting was a boolean, so it was never seen; the first number
 * setting would have shipped as an uneditable row. Declaring the control makes
 * that branch impossible and lets the renderer be exhaustive over a union.
 */
export type SettingControl =
  | { kind: 'boolean' }
  | {
      kind: 'number';
      min: number;
      max: number;
      step: number;
      /** An empty field is a legal value meaning "no default". */
      nullable?: boolean;
      /** Rendered beside the field — "hours", "days", "boxes". */
      unitToken: MessageKey;
    };

export interface SettingDefinition<T> {
  labelToken: MessageKey;
  descriptionToken: MessageKey;
  group: SettingGroup;
  control: SettingControl;
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
 * A whole number inside a range, refused outside it.
 *
 * The bounds live here because `parse` is this key's single validation site on
 * **both** the write path and the read path — so a value that drifts out of
 * range (an older build's wider bound, a hand-edited row) falls back to the
 * default rather than reaching a session stamp or a SQL bind. A range is not
 * decoration on these keys: `security.sessionHours` at 0 signs the
 * administrator out on their next request, and without a ceiling "never sign
 * out" is one text field away.
 */
function asBoundedInt(min: number, max: number) {
  return (raw: unknown): number => {
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max) {
      throw new RangeError(`expected an integer between ${min} and ${max}`);
    }
    return raw;
  };
}

/** `null` — meaning "none" — or a non-negative count, rounded to the 2dp the column holds. */
function asOptionalCount(max: number) {
  return (raw: unknown): number | null => {
    if (raw === null) return null;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > max) {
      throw new RangeError(`expected null or a number between 0 and ${max}`);
    }
    return Math.round(raw * 100) / 100;
  };
}

/**
 * Every setting the product has. Adding one is this entry, its two catalogue
 * tokens in `en.ts` and `hi.ts`, and a third only if it opens a new group — no
 * migration, no column, and no renderer change, because the entry declares the
 * control the screen should draw.
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
    group: 'access',
    control: { kind: 'boolean' },
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
    group: 'stock',
    control: { kind: 'boolean' },
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
    group: 'integrations',
    control: { kind: 'boolean' },
    fallback: false,
    parse: (raw: unknown): boolean => asBoolean(raw),
  },

  /**
   * Whether a panel may join with no password while the Add Office Panel screen
   * is open.
   *
   * `pairPanel`'s auto branch checks `isAcceptingPairing()` and nothing else —
   * no password, no allowlist — so while that window is open any machine on the
   * shop's WiFi can become a trusted panel. `panels.manage` says who may open
   * the window; it cannot say whether an open window may admit a stranger. A
   * company that has finished adding its panels, or whose LAN it does not
   * wholly own, wants the pairing password to be mandatory.
   *
   * `true` is the fallback because an upgraded installation must behave exactly
   * as it did the minute before. The switch is one-directional in effect: there
   * is no value here weaker than today's behaviour.
   */
  'panels.autoPairingEnabled': {
    labelToken: 'setting.panels.autoPairingEnabled.label',
    descriptionToken: 'setting.panels.autoPairingEnabled.help',
    group: 'access',
    control: { kind: 'boolean' },
    fallback: true,
    parse: (raw: unknown): boolean => asBoolean(raw),
  },

  /**
   * Whether the Developer tab can be unlocked on this Master at all.
   *
   * The developer password is a product-wide shared secret whose plaintext is
   * published in `docs/DEVELOPER_MODE.md`, and every developer route is
   * `requireAuth` and nothing more — deliberately, because the intended user
   * may not hold any particular permission. A shop's only defence today is
   * setting `ORDERBOOK_DEVELOPER_PASSWORD` in the Master's `.env`, which no
   * shopkeeper will ever do.
   *
   * **That `.env` override is the floor and is not optional.** While it is set
   * this switch is ignored, so an installation that turns developer mode off
   * and then loses everyone holding `settings.manage` still has a way back in
   * at the machine itself. Without it, those two events together would make a
   * packaged install unrecoverable.
   *
   * Master only. The Office panel has its own gate, but its single tool unpairs
   * that one PC, and honouring this there would mean carrying the value on the
   * snapshot.
   */
  'security.developerModeEnabled': {
    labelToken: 'setting.security.developerModeEnabled.label',
    descriptionToken: 'setting.security.developerModeEnabled.help',
    group: 'access',
    control: { kind: 'boolean' },
    fallback: true,
    parse: (raw: unknown): boolean => asBoolean(raw),
  },

  /**
   * How long a Master-issued session is honoured before the password is needed
   * again.
   *
   * Twelve hours fixed means a Master left signed in at 9am is still signed in
   * at 8pm, and any Office Panel holding that token is still acting as that
   * person. Unlike the time zone and default locale that sit beside it in
   * `master/src/config/index.ts`, this literal reads no `process.env` — it is a
   * policy, not a property of the machine or the network.
   *
   * The `1..24` clamp is the safety floor. `0` would sign out the administrator
   * who typed it on their very next request, and with no ceiling "never sign
   * out" is one text field away. Sessions live in an in-memory map and a Master
   * restart signs everyone out, which bounds the blast radius but does not
   * remove the need for the clamp.
   */
  'security.sessionHours': {
    labelToken: 'setting.security.sessionHours.label',
    descriptionToken: 'setting.security.sessionHours.help',
    group: 'access',
    control: { kind: 'number', min: 1, max: 24, step: 1, unitToken: 'setting.unit.hours' },
    fallback: 12,
    parse: (raw: unknown): number => asBoundedInt(1, 24)(raw),
  },

  /**
   * The low-stock level applied to a (product, colour) line that has none of
   * its own.
   *
   * `reorder_level` is NULL on every row a stock movement creates, and low
   * stock is judged on the reorder level alone — so the Dashboard's "Low stock"
   * tile reads 0 and the "Low only" filter is empty until somebody opens each
   * line and types a number by hand. A shop with hundreds of colours never
   * will, so the feature is dead on every install.
   *
   * `null`, not `0`, is the fallback: `0` would flag every out-of-stock colour
   * the minute an installation upgraded. A line's own explicit level always
   * wins; this only decides what the rest mean, and it is never written onto a
   * line — the drawer's field stays blank, or editing one would silently
   * persist the company default onto that row.
   */
  'inventory.defaultReorderLevel': {
    labelToken: 'setting.inventory.defaultReorderLevel.label',
    descriptionToken: 'setting.inventory.defaultReorderLevel.help',
    group: 'stock',
    control: {
      kind: 'number',
      min: 0,
      max: 100_000,
      step: 1,
      nullable: true,
      unitToken: 'setting.unit.boxes',
    },
    fallback: null as number | null,
    parse: (raw: unknown): number | null => asOptionalCount(100_000)(raw),
  },

  /**
   * Whether a bulk product import may invent a category, or must match one the
   * company already has.
   *
   * `ensureCategories` (`master/src/repositories/product.repository.ts:324`)
   * inserts every name it does not recognise, and `resolveCategoryId`
   * (`:490`) does the same one row at a time on the replay and upsert paths.
   * A supplier's sheet with "Vitrified", "vitrified tiles" and "VITRIFIED
   * TILES " in it therefore leaves three categories behind, and nothing in the
   * product deletes a category once it exists.
   *
   * Off, a row naming a category the company does not have is **refused**, not
   * quietly filed under no category: the same rule a price column the actor may
   * not set already follows (`master/src/domain/product-import.ts:16`) — a
   * success that discarded what the file asserted is the worst answer
   * available. A row with no category column, or a blank cell, is untouched.
   *
   * Refused above the dry-run boundary, so the preview a person approves and
   * the import that follows cannot disagree about a row.
   *
   * `true` is the fallback because an upgraded installation must behave exactly
   * as it did the minute before: today every import creates what it names.
   */
  /**
   * Whether an Office Panel may sign somebody in while the Master is off.
   *
   * The panel keeps a verifier for anybody who has signed in on it before, so
   * a power cut at the Master does not shut the counter. That is a real
   * convenience and a real widening: the Master is where an account is
   * deactivated, a role is narrowed and a password is changed, and a panel
   * working from its own cache is working from the last answer it was given.
   *
   * **The reader is the one place in this product that runs *because* the
   * Master cannot be reached**, so it cannot call `getSetting`. It reads the
   * value off the cached snapshot on disk, which is why this switch is on
   * `CompanyFeatures` rather than read where it is needed. It is therefore as
   * fresh as the panel's last sync — a panel already offline keeps its last
   * answer until it reconnects. That is inherent to an offline replica and is
   * the same propagation the product already accepts for a revoked session.
   *
   * `true` is the fallback, and it also resolves both absences on the panel —
   * a snapshot from a Master too old to carry the field, and no snapshot at
   * all. Fail-closed was tried and rejected on evidence: `snapshot.json` is
   * written without the temp-then-rename the outbox uses, so a power cut mid-
   * write leaves a torn file, and fail-closed would then tell the person at the
   * counter that only somebody who has signed in here before may sign in —
   * a lie they cannot fix without the Master. It also buys nothing: anyone who
   * can delete that file can equally edit the flag inside it.
   */
  'security.offlineSignInEnabled': {
    labelToken: 'setting.security.offlineSignInEnabled.label',
    descriptionToken: 'setting.security.offlineSignInEnabled.help',
    group: 'access',
    control: { kind: 'boolean' },
    fallback: true,
    parse: (raw: unknown): boolean => asBoolean(raw),
  },

  /**
   * Whether correcting a stock count needs a written reason.
   *
   * A correction rewrites a figure nobody can re-derive: the ledger says 40,
   * somebody counts 37, and the three that went missing leave no other trace.
   * `stock.adjust` is already granted separately from ordinary stock entry for
   * that reason; this is the other half, and it is the half an auditor asks
   * for.
   *
   * Confirming a count that already matches is deliberately exempt. That path
   * writes no movement and no activity row, so a reason collected there would
   * be discarded — asking for one would be a form that takes something and
   * throws it away.
   *
   * `false` is the fallback: today a correction takes any note or none.
   */
  'inventory.adjustmentNoteRequired': {
    labelToken: 'setting.inventory.adjustmentNoteRequired.label',
    descriptionToken: 'setting.inventory.adjustmentNoteRequired.help',
    group: 'stock',
    control: { kind: 'boolean' },
    fallback: false,
    parse: (raw: unknown): boolean => asBoolean(raw),
  },

  'catalog.importCreatesCategories': {
    labelToken: 'setting.catalog.importCreatesCategories.label',
    descriptionToken: 'setting.catalog.importCreatesCategories.help',
    group: 'stock',
    control: { kind: 'boolean' },
    fallback: true,
    parse: (raw: unknown): boolean => asBoolean(raw),
  },

  /**
   * How long a lead sits untouched before the Lead Outcomes report calls it
   * "went quiet" rather than "open".
   *
   * The constant this replaces carries the comment "A designer's placeholder,
   * not the owner's number", and three design documents record it as an
   * unanswered owner question. Everything downstream was already built for it
   * to vary — the report payload carries `quietAfterDays` back to the browser
   * and the caption interpolates it. Only the source of the number was never
   * finished.
   *
   * `1..365`: a lead silent for over a year is not a lead, and the value goes
   * straight into a SQL `>=`, so `0` would classify every lead as quiet on the
   * day it was raised.
   */
  /**
   * The follow-up date a new lead is pre-filled with.
   *
   * Shops differ on this and the product had guessed: the New Lead form opened
   * on *today*, which is the one answer that is never a follow-up. Whoever is
   * taking the enquiry can still change it, and the Tomorrow / In 3 days /
   * Next week buttons beside the field do not move with this — they are
   * shortcuts, not the default.
   *
   * `0` is the fallback and means today, which is exactly what the form does
   * now. `0` must stay expressible for that reason: a floor of 1 here would
   * change the shipped behaviour of every installation on upgrade.
   */
  'leads.followUpDefaultDays': {
    labelToken: 'setting.leads.followUpDefaultDays.label',
    descriptionToken: 'setting.leads.followUpDefaultDays.help',
    group: 'leads',
    control: { kind: 'number', min: 0, max: 90, step: 1, unitToken: 'setting.unit.days' },
    fallback: 0,
    parse: (raw: unknown): number => asBoundedInt(0, 90)(raw),
  },

  /**
   * Whether packaging must be chosen on every line before a lead becomes an
   * order.
   *
   * Unlike the others this switch **relaxes** a rule rather than adding one.
   * The rule is already enforced, and correctly: packaging is never inferred,
   * so an unset one has to be caught before the order exists rather than
   * quietly defaulted on the way through. But it is a rule about how a
   * particular shop sells, and a shop that packs to order cannot state the
   * packaging at the moment the lead converts.
   *
   * Off, packaging already entered is still kept — this decides whether the
   * conversion is refused, never whether the field is recorded.
   *
   * `true` is the fallback, which is today's behaviour exactly.
   */
  'leads.packagingRequiredOnConvert': {
    labelToken: 'setting.leads.packagingRequiredOnConvert.label',
    descriptionToken: 'setting.leads.packagingRequiredOnConvert.help',
    group: 'leads',
    control: { kind: 'boolean' },
    fallback: true,
    parse: (raw: unknown): boolean => asBoolean(raw),
  },

  'leads.quietAfterDays': {
    labelToken: 'setting.leads.quietAfterDays.label',
    descriptionToken: 'setting.leads.quietAfterDays.help',
    group: 'leads',
    control: { kind: 'number', min: 1, max: 365, step: 1, unitToken: 'setting.unit.days' },
    fallback: 30,
    parse: (raw: unknown): number => asBoundedInt(1, 365)(raw),
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
