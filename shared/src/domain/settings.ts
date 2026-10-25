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
 * Deliberately declared rather than derived from the key's first segment: that
 * would give a heading per module, several of them over a single setting,
 * which is worse than no grouping at all. These names are the ones a
 * shopkeeper would use over the phone, not the module names the keys are built
 * from.
 */
export const SETTING_GROUPS = [
  'access',
  'products',
  'leads',
  'reports',
  'notices',
  'integrations',
  'data',
] as const;
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
   * `{ configured: boolean }` and never the value — absent, not null, so a
   * client that forgot to strip it cannot pass by comparing against `null`.
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

/**
 * Every setting the product has. Adding one is this entry, its two catalogue
 * tokens in `en.ts`, and a third only if it opens a new group — no
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
   * Whether Office users see the Reports module at all. On unless switched
   * off, so an upgraded company changes nothing the minute it updates. The
   * Master enforces it on every report route and socket command
   * (`report.service.ts#assertReportsVisible`); hiding the nav row is only the
   * courtesy. An administrator or Server Master always sees Reports.
   */
  'reports.visibleToOffice': {
    labelToken: 'setting.reports.visibleToOffice.label',
    descriptionToken: 'setting.reports.visibleToOffice.help',
    group: 'reports',
    control: { kind: 'boolean' },
    fallback: true,
    parse: (raw: unknown): boolean => asBoolean(raw),
  },

  /** The same switch for the Management tier. */
  'reports.visibleToManagement': {
    labelToken: 'setting.reports.visibleToManagement.label',
    descriptionToken: 'setting.reports.visibleToManagement.help',
    group: 'reports',
    control: { kind: 'boolean' },
    fallback: true,
    parse: (raw: unknown): boolean => asBoolean(raw),
  },

  /**
   * The notice board's band at the top of Basic Home (2026-10-08). Only where it shows: the
   * board itself, its sidebar row and the Dashboard card are unchanged either way, and a
   * notice can still be kept off the band one at a time (`notices.show_on_home`).
   */
  'notices.showOnHome': {
    labelToken: 'setting.notices.showOnHome.label',
    descriptionToken: 'setting.notices.showOnHome.help',
    group: 'notices',
    control: { kind: 'boolean' },
    fallback: true,
    parse: (raw: unknown): boolean => asBoolean(raw),
  },

  /** The pop-up of unread notices right after somebody signs in, on both panels. */
  'notices.showAtSignIn': {
    labelToken: 'setting.notices.showAtSignIn.label',
    descriptionToken: 'setting.notices.showAtSignIn.help',
    group: 'notices',
    control: { kind: 'boolean' },
    fallback: true,
    parse: (raw: unknown): boolean => asBoolean(raw),
  },

  /**
   * The "Sell today" pop-up (2026-10-08): the day's entry, once per person per day, on both
   * panels. Off, it never pops up; the entry's products still lead the Basic Home product band.
   */
  'notices.showSellToday': {
    labelToken: 'setting.notices.showSellToday.label',
    descriptionToken: 'setting.notices.showSellToday.help',
    group: 'notices',
    control: { kind: 'boolean' },
    fallback: true,
    parse: (raw: unknown): boolean => asBoolean(raw),
  },

  /**
   * The product band on Basic Home (2026-10-08): today's "Sell today" products, or else sub
   * products with photos, turning over. In the notice board's group because it shares Basic
   * Home's top row with the notice band.
   */
  'basicHome.productSlideshow': {
    labelToken: 'setting.basicHome.productSlideshow.label',
    descriptionToken: 'setting.basicHome.productSlideshow.help',
    group: 'notices',
    control: { kind: 'boolean' },
    fallback: true,
    parse: (raw: unknown): boolean => asBoolean(raw),
  },

  /**
   * Delete related data (2026-10-14), the switch on the Master's Delete data screen. On,
   * deleting a party on the Master that still has new or final orders sends those orders to
   * the Recycle Bin with it, after the dialog has listed every one of them. Off, such a delete
   * is refused naming what still points at the party, as it always was — so `false` is the
   * fallback and an upgraded company changes nothing. In the `data` group, which the Settings
   * screen leaves out: the Delete data screen draws it.
   */
  'parties.deleteRelatedData': {
    labelToken: 'setting.parties.deleteRelatedData.label',
    descriptionToken: 'setting.parties.deleteRelatedData.help',
    group: 'data',
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
   * Whether a bulk product import may invent a category, or must match one the
   * company already has.
   *
   * `ensureCategories` (`master/src/repositories/product.repository.ts`)
   * inserts every name it does not recognise, and `resolveCategoryId` in the
   * same file does the same one row at a time on the replay and upsert paths.
   * A supplier's sheet with "Vitrified", "vitrified tiles" and "VITRIFIED
   * TILES " in it therefore leaves three categories behind, and nothing in the
   * product deletes a category once it exists.
   *
   * Off, a row naming a category the company does not have is **refused**, not
   * quietly filed under no category: a success that discarded what the file
   * asserted is the worst answer available. A row with no category column, or
   * a blank cell, is untouched.
   *
   * Refused above the dry-run boundary, so the preview a person approves and
   * the import that follows cannot disagree about a row.
   *
   * `true` is the fallback because an upgraded installation must behave exactly
   * as it did the minute before: today every import creates what it names.
   */
  'catalog.importCreatesCategories': {
    labelToken: 'setting.catalog.importCreatesCategories.label',
    descriptionToken: 'setting.catalog.importCreatesCategories.help',
    group: 'products',
    control: { kind: 'boolean' },
    fallback: true,
    parse: (raw: unknown): boolean => asBoolean(raw),
  },

  /**
   * The follow-up date a new lead is pre-filled with.
   *
   * Shops differ on this and the product had guessed: the New Lead form opened
   * on *today*, which is the one answer that is never a follow-up. Whoever is
   * taking the enquiry can still change it, and the Tomorrow / In 3 days /
   * Next week buttons beside the field do not move with this — they are
   * shortcuts, not the default.
   *
   * `3` is the fallback: the owner asked for a new lead to start three days
   * out (2026-09-28, `docs/catalogue/CATALOGUE_MODEL.md` §5), and until then
   * the fallback was `0`, today. That moves the form on every installation
   * that never saved a value — which was the request, not a side effect.
   *
   * `0` stays expressible and still means today: a company that wants the old
   * behaviour back sets it, and a floor of 1 would take that answer away.
   */
  'leads.followUpDefaultDays': {
    labelToken: 'setting.leads.followUpDefaultDays.label',
    descriptionToken: 'setting.leads.followUpDefaultDays.help',
    group: 'leads',
    control: { kind: 'number', min: 0, max: 90, step: 1, unitToken: 'setting.unit.days' },
    fallback: 3,
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
   * `false` is the fallback since catalogue v2 (owner's decision, 2026-09-28,
   * `docs/catalogue/CATALOGUE_MODEL.md` §5): lead entry no longer asks for
   * packaging, so a default that refused the conversion would refuse every
   * lead taken on it. A company that packs by rule switches it on, and the
   * lead screens then ask for packaging on every line again. It was `true`
   * before, so an installation that never saved a value changes on upgrade —
   * deliberately, for the same reason.
   */
  'leads.packagingRequiredOnConvert': {
    labelToken: 'setting.leads.packagingRequiredOnConvert.label',
    descriptionToken: 'setting.leads.packagingRequiredOnConvert.help',
    group: 'leads',
    control: { kind: 'boolean' },
    fallback: false,
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
  'leads.quietAfterDays': {
    labelToken: 'setting.leads.quietAfterDays.label',
    descriptionToken: 'setting.leads.quietAfterDays.help',
    group: 'leads',
    control: { kind: 'number', min: 1, max: 365, step: 1, unitToken: 'setting.unit.days' },
    fallback: 30,
    parse: (raw: unknown): number => asBoundedInt(1, 365)(raw),
  },

  /**
   * Whether the note screen ticks Bold unless unticked.
   *
   * On, the Dispatch and Filling notes strip figures and headings print bold,
   * and the preview matches; off, they print in the body face. A rendering
   * choice only, so the fallback is on: an upgraded company sees the sheets it
   * always saw, and a key added here needs no migration at all.
   */
  'notes.defaultBold': {
    labelToken: 'setting.notes.defaultBold.label',
    descriptionToken: 'setting.notes.defaultBold.help',
    group: 'leads',
    control: { kind: 'boolean' },
    fallback: true,
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
