/**
 * Full-state snapshot for Office Panels. A panel that was offline catches up
 * in one round trip on reconnect, then resumes incremental change events.
 *
 * Lives in the service layer so the realtime hub stays pure transport — what a
 * snapshot contains is business policy, not socket wiring.
 */

import type { SyncSnapshot } from '@orderbook/shared';

import * as catalogService from './catalog.service.js';
import * as inventoryService from './inventory.service.js';
import * as leadService from './lead.service.js';

/** One page, deliberately generous: LAN-local and small-business sized. */
const SNAPSHOT_LIMIT = 500;

export async function buildSnapshot(): Promise<SyncSnapshot> {
  const [parties, products, categories, leads, stock] = await Promise.all([
    catalogService.listParties({ limit: SNAPSHOT_LIMIT }),
    catalogService.listProducts({ limit: SNAPSHOT_LIMIT }),
    catalogService.listCategories(),
    leadService.listLeads({ limit: SNAPSHOT_LIMIT }),
    inventoryService.listStock({ limit: SNAPSHOT_LIMIT }),
  ]);

  return {
    parties: parties.items,
    products: products.items,
    categories,
    leads: leads.items,
    stock,
    serverTime: new Date().toISOString(),
  };
}
