/**
 * The company's switches with every absence already resolved.
 *
 * `CompanyFeatures` is optional field by field, and it has to be: a shop
 * mid-update runs a Master and a panel on different versions, so a field the
 * sending Master does not know about arrives as `undefined` (see the type, and
 * `shared/tests/wire-optionality.test.ts`). Absent means "as before".
 *
 * "As before" is the setting's own declared `fallback`, and this is the
 * place that says so. Without it every reader writes its own `?? true`, and the
 * day a fallback changes in `settings.ts` the screens go on using the old one —
 * silently, because a hand-written literal cannot disagree with anything loudly.
 * There were eleven such reads across the two panels when this was written.
 *
 * The rule is that nothing downstream of this call reads an optional field, not
 * that there is one call. The Master's web app resolves once, at its root
 * (`master/web/src/App.tsx`), and hands plain values down as props. The Office
 * web app resolves in each screen that reads a switch, from the
 * `view.features` that screen is already given. The Office server's offline
 * sign-in check reads the one field it needs off the cached snapshot and
 * coalesces it against the same `SETTINGS` fallback directly.
 */

import { SETTINGS } from './settings.js';
import type { CompanyFeatures } from './entities.js';

/** Every switch present, none optional. */
export interface ResolvedCompanyFeatures {
  offlineSignInEnabled: boolean;
  followUpDefaultDays: number;
  packagingRequiredOnConvert: boolean;
  reportsVisibleToOffice: boolean;
  reportsVisibleToManagement: boolean;
}

export function resolveCompanyFeatures(
  features: CompanyFeatures | undefined | null,
): ResolvedCompanyFeatures {
  return {
    offlineSignInEnabled:
      features?.offlineSignInEnabled ?? SETTINGS['security.offlineSignInEnabled'].fallback,
    followUpDefaultDays:
      features?.followUpDefaultDays ?? SETTINGS['leads.followUpDefaultDays'].fallback,
    packagingRequiredOnConvert:
      features?.packagingRequiredOnConvert ??
      SETTINGS['leads.packagingRequiredOnConvert'].fallback,
    reportsVisibleToOffice:
      features?.reportsVisibleToOffice ?? SETTINGS['reports.visibleToOffice'].fallback,
    reportsVisibleToManagement:
      features?.reportsVisibleToManagement ?? SETTINGS['reports.visibleToManagement'].fallback,
  };
}
