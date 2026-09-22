/**
 * The company's switches with every absence already resolved.
 *
 * `CompanyFeatures` is optional field by field, and it has to be: a shop
 * mid-update runs a Master and a panel on different versions, so a field the
 * sending Master does not know about arrives as `undefined` (see the type, and
 * `shared/tests/wire-optionality.test.ts`). Absent means "as before".
 *
 * "As before" is the setting's own declared `fallback`, and this is the one
 * place that says so. Without it every reader writes its own `?? true`, and the
 * day a fallback changes in `settings.ts` the screens go on using the old one —
 * silently, because a hand-written literal cannot disagree with anything loudly.
 * There were eleven such reads across the two panels when this was written.
 *
 * Both panels resolve at their own edge, once, and pass plain values inward, so
 * a shared screen never has to know the switch might be missing.
 */

import { SETTINGS } from './settings.js';
import type { CompanyFeatures } from './entities.js';

/** Every switch present, none optional. */
export interface ResolvedCompanyFeatures {
  freeToSell: boolean;
  offlineSignInEnabled: boolean;
  adjustmentNoteRequired: boolean;
  followUpDefaultDays: number;
  packagingRequiredOnConvert: boolean;
}

export function resolveCompanyFeatures(
  features: CompanyFeatures | undefined | null,
): ResolvedCompanyFeatures {
  return {
    freeToSell: features?.freeToSell ?? SETTINGS['inventory.freeToSell'].fallback,
    offlineSignInEnabled:
      features?.offlineSignInEnabled ?? SETTINGS['security.offlineSignInEnabled'].fallback,
    adjustmentNoteRequired:
      features?.adjustmentNoteRequired ?? SETTINGS['inventory.adjustmentNoteRequired'].fallback,
    followUpDefaultDays:
      features?.followUpDefaultDays ?? SETTINGS['leads.followUpDefaultDays'].fallback,
    packagingRequiredOnConvert:
      features?.packagingRequiredOnConvert ??
      SETTINGS['leads.packagingRequiredOnConvert'].fallback,
  };
}
