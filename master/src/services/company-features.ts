/**
 * The company switches the screens read, resolved from settings once per
 * caller and handed out with the signed-in user (Master) and the snapshot
 * (Office panel) — so both UIs draw the same screen without a second request,
 * and neither needs `settings.manage` to know which way a switch points.
 */

import type { CompanyFeatures, SettingKey } from '@orderbook/shared';

import { getSetting } from './settings.service.js';

/**
 * Resolved in one place, for both channels.
 *
 * `getSetting` is cached per tenant, so six reads are one query — and one
 * function is what stops the Master's `/me` and the panel's snapshot answering
 * differently about the same company.
 *
 * Every field the interface declares must be assigned here. Nothing in the type
 * system says so, because they are all optional on purpose (see
 * `CompanyFeatures`), so a field added to the interface and forgotten here
 * typechecks cleanly and reaches every reader as "as before" for ever.
 * `master/tests/company-features-complete.test.ts` is what catches that.
 */
export async function companyFeatures(tenantId: string): Promise<CompanyFeatures> {
  /*
   * Read as named properties, never as a positional array.
   *
   * `Promise.all` with an array destructure would be shorter and is how this
   * was first written. Four of these six are booleans, so swapping two of them
   * — inserting a key in the reads and not in the destructure — typechecks
   * perfectly and hands every panel the wrong switch under the right name.
   * Naming both ends makes that a compile error instead.
   */
  const read = async <K extends SettingKey>(key: K) =>
    [key, await getSetting(tenantId, key)] as const;

  const values = Object.fromEntries(
    await Promise.all([
      read('inventory.freeToSell'),
      read('security.offlineSignInEnabled'),
      read('inventory.adjustmentNoteRequired'),
      read('leads.followUpDefaultDays'),
      read('leads.packagingRequiredOnConvert'),
    ]),
  ) as {
    'inventory.freeToSell': boolean;
    'security.offlineSignInEnabled': boolean;
    'inventory.adjustmentNoteRequired': boolean;
    'leads.followUpDefaultDays': number;
    'leads.packagingRequiredOnConvert': boolean;
  };

  return {
    freeToSell: values['inventory.freeToSell'],
    offlineSignInEnabled: values['security.offlineSignInEnabled'],
    adjustmentNoteRequired: values['inventory.adjustmentNoteRequired'],
    followUpDefaultDays: values['leads.followUpDefaultDays'],
    packagingRequiredOnConvert: values['leads.packagingRequiredOnConvert'],
  };
}

export async function freeToSell(tenantId: string): Promise<boolean> {
  return getSetting(tenantId, 'inventory.freeToSell');
}
