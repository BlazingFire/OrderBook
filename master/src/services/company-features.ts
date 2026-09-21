/**
 * The company switches the screens read, resolved from settings once per
 * caller and handed out with the signed-in user (Master) and the snapshot
 * (Office panel) — so both UIs draw the same screen without a second request,
 * and neither needs `settings.manage` to know which way a switch points.
 */

import type { CompanyFeatures } from '@orderbook/shared';

import { getSetting } from './settings.service.js';

export async function companyFeatures(tenantId: string): Promise<CompanyFeatures> {
  return { freeToSell: await getSetting(tenantId, 'inventory.freeToSell') };
}

export async function freeToSell(tenantId: string): Promise<boolean> {
  return getSetting(tenantId, 'inventory.freeToSell');
}
