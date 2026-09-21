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
import { peekHlc } from '../repositories/identity.repository.js';
import * as partyAccessRepo from '../repositories/party-access.repository.js';
import * as variantRepo from '../repositories/party-variant.repository.js';
import * as pipelineRepo from '../repositories/pipeline.repository.js';
import * as syncRepo from '../repositories/sync.repository.js';
import { resolvePartyScope } from '../domain/party-scope.js';
import { canSeeRates, maskVariant } from '../domain/visibility.js';
import * as catalogService from './catalog.service.js';
import { companyFeatures } from './company-features.js';
import * as dashboardService from './dashboard.service.js';
import * as inventoryService from './inventory.service.js';
import * as leadService from './lead.service.js';
import * as orderService from './order.service.js';
import { appVersion } from '../lib/app-version.js';
import { BOOT_ID, currentSeq } from '../realtime/change-ring.js';

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

  // The six collections above come from services that scope themselves. These
  // two call repositories directly, so they have to be given the scope by hand
  // — and both leak without it: a variant is another party's negotiated rate,
  // and a conflict names the lead or order it belongs to.
  const partyScope = resolvePartyScope(actor);

  const [variants, pipelines, optionLists, customFields, conflicts, serverHlc, dashboard, features] =
    await Promise.all([
      variantRepo.listAll(actor.tenantId, partyScope),
      pipelineRepo.listPipelines(actor.tenantId),
      customFieldRepo.listOptions(actor.tenantId),
      customFieldRepo.listDefinitions(actor.tenantId),
      syncRepo.listConflicts(actor.tenantId, { limit: 100, scope: partyScope }),
      peekHlc(),
      dashboardService.getDashboardSummary(actor),
      companyFeatures(actor.tenantId),
    ]);

  const allowed = canSeeRates(actor);

  // This person's own Party Access grants over the parties above. The panel
  // uses them for two things: the "My parties" toggle, and leaving a view-only
  // party out of the Add Lead picker rather than offering one whose save the
  // Master will refuse. The refusal still stands either way — this only stops
  // the UI walking somebody into it.
  const partyGrants = await partyAccessRepo.grantsForUser(
    actor.tenantId,
    partyScope.userId,
    parties.map((party) => party.id),
  );

  return {
    bootId: BOOT_ID,
    // Where the ring stands as this snapshot is built. A change that lands
    // *while* it is being built is replayed on the next reconnect rather than
    // missed — the cost of a duplicate upsert is nothing, and the cost of the
    // other rounding is a lost row.
    seq: currentSeq(),
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
    partyGrants,
    builtForUserId: partyScope.userId,
    serverHlc,
    serverTime: new Date().toISOString(),
    serverVersion: appVersion(),
    // False whenever `products` was denied by permission or clamped by
    // SNAPSHOT_LIMIT — either way it is not the complete catalogue, and the
    // Office image cache sweep must not treat it as one.
    productsComplete: canProducts && products.length < SNAPSHOT_LIMIT,
    features,
  };
}
