/**
 * Full-state snapshot for Office Panels. A panel that was offline catches up in
 * one round trip on reconnect, then resumes incremental change events.
 *
 * Deliberately fat. This is not only a catch-up payload — it is the panel's
 * **offline working set**. Everything the Add Lead screen needs to build a line
 * item with no network has to be in here: the catalogue, the party variants,
 * the pipelines that define the Kanban columns, the option lists, and the
 * custom field definitions that decide whether a lead is complete.
 *
 * Lives in the service layer so the realtime hub stays pure transport — what a
 * snapshot contains is business policy, not socket wiring.
 */

import type { SyncSnapshot } from '@orderbook/shared';

import type { ActorContext } from '../domain/actor.js';
import * as customFieldRepo from '../repositories/custom-field.repository.js';
import { currentHlc } from '../repositories/identity.repository.js';
import * as variantRepo from '../repositories/party-variant.repository.js';
import * as pipelineRepo from '../repositories/pipeline.repository.js';
import * as syncRepo from '../repositories/sync.repository.js';
import { canSeeRates, maskVariant } from '../domain/visibility.js';
import * as catalogService from './catalog.service.js';
import * as inventoryService from './inventory.service.js';
import * as leadService from './lead.service.js';
import * as orderService from './order.service.js';

/** One page, deliberately generous: LAN-local and small-business sized. */
const SNAPSHOT_LIMIT = 500;

export async function buildSnapshot(actor: ActorContext): Promise<SyncSnapshot> {
  const [parties, products, categories, leads, orders, stock] = await Promise.all([
    catalogService.listParties({ limit: SNAPSHOT_LIMIT }, actor),
    catalogService.listProducts({ limit: SNAPSHOT_LIMIT }, actor),
    catalogService.listCategories(actor),
    leadService.listLeads({ limit: SNAPSHOT_LIMIT }, actor),
    orderService.listOrders({ limit: SNAPSHOT_LIMIT }, actor),
    inventoryService.listStock({ limit: SNAPSHOT_LIMIT }, actor),
  ]);

  const [variants, pipelines, optionLists, customFields, conflicts, serverHlc] = await Promise.all([
    variantRepo.listAll(actor.tenantId),
    pipelineRepo.listPipelines(actor.tenantId),
    customFieldRepo.listOptions(actor.tenantId),
    customFieldRepo.listDefinitions(actor.tenantId),
    syncRepo.listConflicts(actor.tenantId, { limit: 100 }),
    currentHlc(),
  ]);

  const allowed = canSeeRates(actor);

  return {
    parties: parties.items,
    products: products.items,
    categories,
    partyVariants: variants.map((variant) => maskVariant(variant, allowed)),
    leads: leads.items,
    orders: orders.items,
    stock,
    pipelines,
    optionLists,
    customFields,
    conflicts,
    // Sent so the panel can hide controls it may not use. It is a UI courtesy,
    // never the enforcement — every mutation is checked again on arrival.
    permissions: [...(actor.permissions?.permissions ?? [])],
    serverHlc,
    serverTime: new Date().toISOString(),
  };
}
