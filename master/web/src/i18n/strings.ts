/**
 * The Master Panel's view onto the one string catalogue.
 *
 * This file used to *be* a catalogue: 1029 keys, hand-maintained, alongside
 * office's 501. They were forks. 129 keys existed in both, 12 of those had
 * drifted to different sentences, and five call sites already asked for keys
 * their own panel did not have — so the Master rendered `common.save` and
 * `lead.add.products.freeToSell` as raw keys on screen, live, because those
 * keys only ever existed in office's copy. Adding a string meant editing two
 * files by hand, and nothing checked that you had.
 *
 * Everything now lives in `shared/src/i18n/en.ts`, which is type-checked
 * (`MessageKey`), placeholder-checked (`ParamsFor`) and has a Hindi mirror
 * kept total by `npm run i18n:sync`.
 *
 * The twelve keys that legitimately differ between panels are namespaced
 * `master.*` / `office.*` in the catalogue and resolved here, so a call site
 * asks for `sync.offline` and gets its own panel's reading.
 */

import {
  DEFAULT_LOCALE,
  isLocale,
  t as translate,
  type Locale,
  type MessageKey,
  type MessageParams,
} from '@orderbook/shared';

/**
 * Keys whose sentence differs between the two panels.
 *
 * "Offline" means something different on each: the Master is reporting that
 * *panels* are unreachable, the Office panel that *it* is. Namespacing keeps
 * both readings correct rather than forcing one wording onto both.
 */
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

const KEY_LOCALE = 'ob.locale';

function locale(): Locale {
  try {
    const stored = window.localStorage.getItem(KEY_LOCALE);
    return isLocale(stored) ? stored : DEFAULT_LOCALE;
  } catch {
    // Private browsing, or storage disabled. English is the honest fallback.
    return DEFAULT_LOCALE;
  }
}

/**
 * Deliberately still `key: string` rather than `MessageKey`.
 *
 * Tightening it is a separate change touching ~1380 call sites; until then
 * `master/tests/i18n-call-sites.test.ts` scans every literal `t('…')` in both
 * web apps and fails if the key is not in the catalogue, which is the same
 * guarantee a day earlier. `translate` falls back to the raw key exactly as
 * this function used to, so an unknown key still renders greppably rather
 * than blank.
 */
export function t(key: string, params?: MessageParams): string {
  const resolved = PANEL_SCOPED.has(key) ? `master.${key}` : key;
  return translate(locale(), resolved as MessageKey, params as never);
}
