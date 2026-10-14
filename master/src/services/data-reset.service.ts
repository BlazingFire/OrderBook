/**
 * Start fresh — the Master's Delete data screen (`shared/src/domain/data-reset.ts`).
 *
 * Erases every new order, final order and party of the company, for every
 * user and panel, while the Master keeps running: products, users, roles,
 * settings, panels, option lists and the activity log stay. A hard delete,
 * not the Recycle Bin, so it is gated three times — the admin tier (an
 * administrator or a Server Master) with `settings.manage`, the person's own
 * password, and the typed word `FRESH_START_CONFIRMATION`.
 *
 * Not `wipe:business` (`catalog-reload-cli.ts`): that one truncates the
 * catalogue and the activity log too, restarts every id counter, and needs the
 * Master stopped. Here the counters are left alone, as `clearCatalogueData`
 * leaves them, so an old activity row never names a new record that took its
 * number and a printed PO number is never handed out twice.
 */

import {
  FRESH_START_CONFIRMATION,
  type ChatClearResult,
  type DataDeleteConfirmInput,
  type FreshStartInput,
  type PrintHistoryClearResult,
  type FreshStartResult,
  type FreshStartSummary,
} from '@orderbook/shared';

import { assertAdminTier } from '../domain/access.js';
import { requirePermission, type ActorContext } from '../domain/actor.js';
import { db } from '../db/knex.js';
import { ValidationError } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { verifyPassword } from '../lib/password.js';
import { panelLink } from '../realtime/panel-link.js';
import * as activityLog from '../repositories/activity-log.repository.js';
import * as userRepo from '../repositories/user.repository.js';
import { publishChange } from './change-bus.js';
import { eraseAllMessages } from './chat.service.js';
import { eraseFinishedJobs, historyCounts } from './print.service.js';

const log = createLogger('data-reset');

/** Who may open the screen and use either tool's server side. */
function assertMayReset(actor: ActorContext): void {
  requirePermission(actor, 'settings.manage');
  assertAdminTier(actor, 'settings.manage');
}

async function countRows(table: string, tenantId: string, apply?: (query: ReturnType<ReturnType<typeof db>>) => void) {
  const query = db()(table).where({ tenant_id: tenantId });
  apply?.(query);
  const [row] = await query.count<Array<{ count: string | number }>>('* as count');
  return Number(row?.count ?? 0);
}

/**
 * The typed word, then the person's own password — for every hard delete here.
 * A 400, never a 401: the window would read a 401 as its session ending.
 */
async function assertConfirmed(input: DataDeleteConfirmInput, actor: ActorContext): Promise<void> {
  if (input.confirmText !== FRESH_START_CONFIRMATION) {
    throw new ValidationError('validation.dataReset.confirmText', {}, { field: 'confirmText' });
  }
  const credential = actor.userId ? await userRepo.readCredentialById(actor.tenantId, actor.userId) : null;
  const { matches } = await verifyPassword(input.confirmPassword ?? '', credential?.passwordHash ?? null);
  if (!matches) {
    throw new ValidationError('validation.dataReset.passwordIncorrect', {}, { field: 'confirmPassword' });
  }
}

/** What Start fresh would remove and keep, counted now (binned rows included). */
export async function freshStartSummary(actor: ActorContext): Promise<FreshStartSummary> {
  assertMayReset(actor);
  const tenantId = actor.tenantId;

  const [pendingOrders, finalOrders, parties, products, users, chatMessages, print] = await Promise.all([
    countRows('leads', tenantId, (query) => void query.whereNull('converted_order_id')),
    countRows('orders', tenantId),
    countRows('parties', tenantId),
    countRows('products', tenantId, (query) => void query.whereNull('deleted_at')),
    countRows('users', tenantId, (query) => void query.whereNull('deleted_at')),
    countRows('chat_messages', tenantId),
    historyCounts(tenantId),
  ]);

  return {
    pendingOrders,
    finalOrders,
    parties,
    products,
    users,
    chatMessages,
    printHistory: print.finished,
    printWaiting: print.waiting,
  };
}

/**
 * Delete every order and party. Children before parents, in one transaction
 * that holds the order and party tables against writes, so a lead saved from
 * a panel mid-wipe either lands before it (and goes) or after it (and is
 * refused, its party gone) — never half.
 */
export async function freshStart(input: FreshStartInput, actor: ActorContext): Promise<FreshStartResult> {
  assertMayReset(actor);

  await assertConfirmed(input, actor);

  const tenantId = actor.tenantId;

  const removed = await db().transaction(async (trx) => {
    // EXCLUSIVE: reads go on, every write to these waits for the commit.
    await trx.raw(
      'LOCK TABLE parties, leads, orders, line_items, timeline_entries, party_product_variants, party_access IN EXCLUSIVE MODE',
    );

    const scoped = (table: string) => trx(table).where({ tenant_id: tenantId });

    const [pendingRow] = await scoped('leads')
      .whereNull('converted_order_id')
      .count<Array<{ count: string | number }>>('* as count');

    await scoped('stock_reservations').delete();
    await scoped('line_items').delete();
    await scoped('timeline_entries').delete();
    // A conflict about a record that no longer exists can never be resolved.
    await scoped('sync_conflicts').whereIn('entity', ['lead', 'order', 'party', 'party_variant']).delete();

    // Leads and orders point at each other (`converted_order_id`, `lead_id`),
    // so the cycle is broken before either goes.
    await scoped('leads').update({ converted_order_id: null });
    const finalOrders = await scoped('orders').delete();
    const leads = await scoped('leads').delete();

    await scoped('party_product_variants').delete();
    await scoped('party_access').delete();
    const parties = await scoped('parties').delete();

    // The connectors' links would otherwise name records that no longer exist.
    await scoped('api_connector_links').whereIn('entity', ['party', 'lead', 'order']).delete();
    // A bell entry that opens a deleted order opens nothing.
    await scoped('user_notifications').whereRaw("link->>'kind' = 'lead'").delete();

    const counts = {
      pendingOrders: Math.min(Number(pendingRow?.count ?? 0), leads),
      finalOrders,
      parties,
    };

    await activityLog.recordActivity(
      {
        tenantId,
        entityType: 'party_list',
        entityId: tenantId,
        action: 'erased',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { ...counts },
      },
      actor,
      trx,
    );

    return counts;
  });

  log.warn(
    `Start fresh: deleted ${removed.pendingOrders} new orders, ${removed.finalOrders} final orders and ` +
      `${removed.parties} parties (by ${actor.actorName ?? actor.actorId ?? 'unknown'})`,
  );

  // One event for the whole book, as a bulk party import sends: every Master
  // screen that shows orders or parties reads again, and every panel takes a
  // fresh snapshot (`party_bulk` is snapshot-forcing). A panel whose user may
  // not see parties is not sent that event, so every panel is re-snapshotted
  // as well.
  publishChange({ entity: 'party_bulk', action: 'deleted', id: tenantId, payload: { ...removed } });
  panelLink()?.resnapshotAll?.();

  return { ok: true, removed };
}

/** Delete every chat message; groups and members stay (`chat.service.ts#eraseAllMessages`). */
export async function clearChat(input: DataDeleteConfirmInput, actor: ActorContext): Promise<ChatClearResult> {
  assertMayReset(actor);
  await assertConfirmed(input, actor);
  const messages = await eraseAllMessages(actor);
  log.warn(`Deleted every chat message (${messages}) (by ${actor.actorName ?? actor.actorId ?? 'unknown'})`);
  return { ok: true, removed: { messages } };
}

/** Delete every printed and cancelled Printroom job (`print.service.ts#eraseFinishedJobs`). */
export async function clearPrintHistory(
  input: DataDeleteConfirmInput,
  actor: ActorContext,
): Promise<PrintHistoryClearResult> {
  assertMayReset(actor);
  await assertConfirmed(input, actor);
  const jobs = await eraseFinishedJobs(actor);
  log.warn(`Cleared the Printroom history (${jobs} jobs) (by ${actor.actorName ?? actor.actorId ?? 'unknown'})`);
  return { ok: true, removed: { jobs } };
}
