/**
 * The Office Panel's view onto the one string catalogue.
 *
 * The twin of `master/web/src/i18n/strings.ts` — see that file for why both
 * of these stopped being catalogues of their own. Everything now lives in
 * `shared/src/i18n/en.ts`; the twelve keys that legitimately differ between
 * panels are namespaced `master.*` / `office.*` there and resolved here.
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
 * *panels* are unreachable, this one that *it* is. The list is identical to
 * the Master's by construction — it is the set of keys that existed in both
 * dictionaries with different text.
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
    return DEFAULT_LOCALE;
  }
}

/** See the Master's copy for why this is still `key: string`. */
export function t(key: string, params?: MessageParams): string {
  const resolved = PANEL_SCOPED.has(key) ? `office.${key}` : key;
  return translate(locale(), resolved as MessageKey, params as never);
}
