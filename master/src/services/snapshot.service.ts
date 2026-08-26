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

import { actorCan, type ActorContext } from '../domain/actor.js';
import * as customFieldRepo from '../repositories/custom-field.repository.js';
import { currentHlc } from '../repositories/identity.repository.js';
import * as variantRepo from '../repositories/party-variant.repository.js';
import * as pipelineRepo from '../repositories/pipeline.repository.js';
import * as syncRepo from '../repositories/sync.repository.js';
import { canSeeRates, maskVariant } from '../domain/visibility.js';
import * as catalogService from './catalog.service.js';
import * as dashboardService from './dashboard.service.js';
import * as inventoryService from './inventory.service.js';
import * as leadService from './lead.service.js';
import * as orderService from './order.service.js';
import { appVersion } from '../lib/app-version.js';

/** One page, deliberately generous: LAN-local and small-business sized. */
const SNAPSHOT_LIMIT = 500;

/**
 * Each collection is gated on the permission its own list endpoint requires,
 * resolving to empty rather than calling through — `listParties` and its
 * siblings throw `ForbiddenError` via `requirePermission`, and a snapshot
 * fetched for an actor missing even one module permission must not fail the
 * whole request (`docs/backend-modules/10-TESTING.md` `DSH-7`). This is a
 * "was it visible at all" gate, not the finer per-field masking below.
 */
export async function buildSnapshot(actor: ActorContext): Promise<SyncSnapshot> {
  const canParties = actorCan(actor, 'parties.view');
  const canProducts = actorCan(actor, 'products.view');
  const canLeads = actorCan(actor, 'leads.view');
  const canOrders = actorCan(actor, 'orders.view');
  const canInventory = actorCan(actor, 'inventory.view');

  const [parties, products, categories, leads, orders, stock] = await Promise.all([
    canParties
      ? catalogService.listParties({ limit: SNAPSHOT_LIMIT }, actor).then((page) => page.items)
      : Promise.resolve([]),
    canProducts
      ? catalogService.listProducts({ limit: SNAPSHOT_LIMIT }, actor).then((page) => page.items)
      : Promise.resolve([]),
    canProducts ? catalogService.listCategories(actor) : Promise.resolve([]),
    canLeads
      ? leadService.listLeads({ limit: SNAPSHOT_LIMIT }, actor).then((page) => page.items)
      : Promise.resolve([]),
    canOrders
      ? orderService.listOrders({ limit: SNAPSHOT_LIMIT }, actor).then((page) => page.items)
      : Promise.resolve([]),
    canInventory ? inventoryService.listStock({ limit: SNAPSHOT_LIMIT }, actor) : Promise.resolve([]),
  ]);

  const [variants, pipelines, optionLists, customFields, conflicts, serverHlc, dashboard] = await Promise.all([
    variantRepo.listAll(actor.tenantId),
    pipelineRepo.listPipelines(actor.tenantId),
    customFieldRepo.listOptions(actor.tenantId),
    customFieldRepo.listDefinitions(actor.tenantId),
    syncRepo.listConflicts(actor.tenantId, { limit: 100 }),
    currentHlc(),
    dashboardService.getDashboardSummary(actor),
  ]);

  const allowed = canSeeRates(actor);

  return {
    parties,
    products,
    categories,
    partyVariants: variants.map((variant) => maskVariant(variant, allowed)),
    leads,
    orders,
    stock,
    pipelines,
    optionLists,
    customFields,
    conflicts,
    dashboard,
    // Sent so the panel can hide controls it may not use. It is a UI courtesy,
    // never the enforcement — every mutation is checked again on arrival.
    permissions: [...(actor.permissions?.permissions ?? [])],
    serverHlc,
    serverTime: new Date().toISOString(),
    serverVersion: appVersion(),
  };
}
