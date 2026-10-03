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
 * `getSetting` is cached per tenant, so once the cache is warm the reads
 * cost no query at all (on a cold cache the five run in parallel and each
 * loads the tenant's settings — nothing de-duplicates a load in flight). And
 * one function is what stops the Master's `/me` and the panel's snapshot
 * answering differently about the same company.
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
   * was first written. Most of these are booleans, so swapping two of them
   * — inserting a key in the reads and not in the destructure — typechecks
   * perfectly and hands every panel the wrong switch under the right name.
   * Naming both ends makes that a compile error instead.
   */
  const read = async <K extends SettingKey>(key: K) =>
    [key, await getSetting(tenantId, key)] as const;

  const values = Object.fromEntries(
    await Promise.all([
      read('security.offlineSignInEnabled'),
      read('leads.followUpDefaultDays'),
      read('leads.packagingRequiredOnConvert'),
      read('reports.visibleToOffice'),
      read('reports.visibleToManagement'),
    ]),
  ) as {
    'security.offlineSignInEnabled': boolean;
    'leads.followUpDefaultDays': number;
    'leads.packagingRequiredOnConvert': boolean;
    'reports.visibleToOffice': boolean;
    'reports.visibleToManagement': boolean;
  };

  return {
    offlineSignInEnabled: values['security.offlineSignInEnabled'],
    followUpDefaultDays: values['leads.followUpDefaultDays'],
    packagingRequiredOnConvert: values['leads.packagingRequiredOnConvert'],
    reportsVisibleToOffice: values['reports.visibleToOffice'],
    reportsVisibleToManagement: values['reports.visibleToManagement'],
  };
}
