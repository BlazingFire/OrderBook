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
  type Locale,
  type MessageKey,
  type MessageParams,
  type Translator,
} from '@orderbook/shared';

import { uiConfig } from './config.js';

const KEY_LOCALE = 'ob.locale';

/** Keys whose sentence differs between panels. */
const PANEL_SCOPED: ReadonlySet<string> = new Set([
  'app.panel',
  'backup.export.title',
  'backup.restore.confirmWipe',
  'search.failedOffline',
  'settings.storage.title',
  'sync.conflictReview',
  'sync.offline',
  'sync.offlinePending',
  'sync.pendingChanges',
  'sync.popoverTitle.offline',
  'sync.popoverTitle.offlinePending',
  'sync.popoverTitle.synced',
]);

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
