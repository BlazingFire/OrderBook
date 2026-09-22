/**
 * The one place UI code turns a message key into a sentence.
 *
 * Both panels used to carry a hand-maintained dictionary of their own — 1029
 * keys and 501, sharing 129, of which 12 had drifted to different sentences
 * and five were being asked for by a panel that did not have them, rendering
 * the raw key on screen. Everything now lives in `shared/src/i18n/en.ts`.
 *
 * The twelve keys that legitimately differ between panels are namespaced
 * `master.*` / `office.*` in the catalogue and resolved here from
 * `uiConfig().panel`, so a call site asks for `sync.offline` and gets its own
 * panel's reading. "Offline" means different things on each: the Master is
 * reporting that *panels* are unreachable, the Office panel that *it* is.
 */

import {
  createTranslator,
  DEFAULT_LOCALE,
  isLocale,
  PANEL_SCOPED_KEYS,
  type Locale,
  type MessageKey,
  type MessageParams,
  type Translator,
} from '@orderbook/shared';

import { uiConfig } from './config.js';

const KEY_LOCALE = 'ob.locale';

/** Keys whose sentence differs between panels — the list lives in `shared/`. */
const PANEL_SCOPED: ReadonlySet<string> = new Set(PANEL_SCOPED_KEYS);

export function locale(): Locale {
  try {
    const stored = window.localStorage.getItem(KEY_LOCALE);
    return isLocale(stored) ? stored : DEFAULT_LOCALE;
  } catch {
    // Private browsing, or storage disabled. English is the honest fallback.
    return DEFAULT_LOCALE;
  }
}

/**
 * Store the chosen locale. Per machine, never synced — the same rule as theme
 * and density (`shared/src/i18n/locales.ts`).
 *
 * It does **not** re-render anything. `t()` reads storage on every call, so a
 * component re-rendered for its own reasons would come back in the new
 * language while its neighbours stayed in the old one, and the screen would
 * end up half-translated with no way back short of a reload. The picker in
 * `SettingsLayout` therefore reloads, and says so before it does.
 *
 * Swallowing the write failure is deliberate: storage being unavailable is the
 * same condition `locale()` already treats as "English", and there is nothing
 * useful to tell somebody whose browser refuses to remember anything.
 */
export function setLocale(next: Locale): void {
  try {
    window.localStorage.setItem(KEY_LOCALE, next);
  } catch {
    // Private browsing, or storage disabled.
  }
}

/**
 * Take the deployment's language on a browser profile that has never chosen
 * one, and only then.
 *
 * `ORDERBOOK_DEFAULT_LOCALE` reaches each panel's boot endpoint as
 * `defaultLocale` — the Master's `/api/auth/me`, the Office's `/api/session`.
 * Both have served it since the config was written and neither web app read
 * it, so a Hindi deployment still opened in English on every new PC. Each
 * panel calls this from its boot sequence, behind the splash and before the
 * shell first renders, so the adopted language is the one the shell paints in.
 *
 * It writes once and never again: after that the machine has a stored locale
 * and the picker in Settings owns it. Changing the environment variable later
 * is deliberately not retroactive — a default describes where somebody starts,
 * not a choice that is re-imposed on them at every boot.
 */
export function adoptDefaultLocale(next: unknown): void {
  if (!isLocale(next)) return;
  try {
    if (window.localStorage.getItem(KEY_LOCALE) === null) {
      window.localStorage.setItem(KEY_LOCALE, next);
    }
  } catch {
    // Private browsing, or storage disabled.
  }
}

/**
 * The bound translator, for the one consumer that needs the object rather
 * than the function: `renderActivity()` takes a `Translator`, and the activity
 * log screen was constructing its own with a hard-coded `'en'` — which would
 * have made it the single screen ignoring the stored locale.
 */
export function translator(): Translator {
  return createTranslator(locale());
}

/**
 * Deliberately `key: string` rather than `MessageKey`.
 *
 * Tightening it is a separate change across ~1380 call sites. Until then
 * `master/tests/i18n-call-sites.test.ts` reads both web apps, finds every
 * literal `t('…')` and fails if the catalogue lacks the key — the same
 * guarantee, a day earlier. The underlying `t` falls back to returning the raw
 * key, so an unknown one renders greppably rather than blank.
 */
export function t(key: string, params?: MessageParams): string {
  const resolved = PANEL_SCOPED.has(key) ? `${uiConfig().panel}.${key}` : key;
  return translator().t(resolved as MessageKey, params as never);
}
