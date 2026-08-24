/**
 * The audit trail (docs/ROLES_AND_USERS.md §7, §9).
 *
 * The entry and the change it describes commit together or not at all. That is
 * the guarantee §7 states, and until this file took a transaction it was not
 * true in either direction: a failed audit insert left the projection committed
 * with nothing recorded, and an entry written inside a transaction that later
 * rolled back survived as a record of something that never happened.
 *
 * Both were possible because the insert went out on the root pool — a *different
 * connection* from the caller's transaction — and then swallowed its own errors
 * into a warning. The comment that used to live here argued this was deliberate:
 * "an order that saved successfully should not fail because its log row could
 * not be written". That reasoning is wrong for an audit trail specifically. A
 * trail that is allowed to have holes cannot answer the question it exists to
 * answer, and the holes appear exactly when something is going wrong — which is
 * when the record matters most.
 *
 * **The cost, accepted deliberately.** The `activity_log` chain trigger takes a
 * per-tenant advisory lock to serialise the hash chain. Holding that inside the
 * caller's transaction means every audited write for one company queues behind
 * the others. At this product's scale — one company, a handful of panels,
 * human-paced actions — that is not a real constraint, and it buys a trail that
 * is actually atomic with what it records.
 */

import { createLogger } from '../lib/logger.js';
import type { TransactionContext } from './transaction.js';

const log = createLogger('activity');

export type ActorType = 'user' | 'office_panel' | 'system';

export interface ActivityEntry {
  tenantId: string;
  entityType: string;
  entityId: string;
  action: string;
  actorType: ActorType;
  actorId: string | null;
  details?: Record<string, unknown>;
}

/**
 * Append one entry, inside the caller's transaction.
 *
 * The transaction is **required**. Making it optional would leave the old
 * behaviour reachable by omission, and "forgot to pass the transaction" looks
 * identical to "chose not to" at every call site.
 */
export async function recordActivity(
  entry: ActivityEntry,
  trx: TransactionContext,
): Promise<void> {
  await trx('activity_log').insert({
    tenant_id: entry.tenantId,
    entity_type: entry.entityType,
    entity_id: entry.entityId,
    action: entry.action,
    actor_type: entry.actorType,
    actor_id: entry.actorId,
    details: entry.details ? JSON.stringify(entry.details) : null,
  });
}

/**
 * Append an entry that has no transaction to belong to.
 *
 * The narrow case this exists for is a *failed* operation worth recording — a
 * refused sign-in, say — where there is no successful change to be atomic with,
 * and where throwing would replace a useful audit entry with a confusing 500.
 *
 * Every write path uses `recordActivity` instead. If you are reaching for this
 * from a service that has a transaction open, you want that one.
 */
export async function recordDetachedActivity(
  entry: ActivityEntry,
  runner: { transaction: <T>(handler: (trx: TransactionContext) => Promise<T>) => Promise<T> },
): Promise<void> {
  try {
    await runner.transaction((trx) => recordActivity(entry, trx));
  } catch (error) {
    // Logged, never silent. An earlier version discarded this, and when the
    // tenancy migration made `tenant_id` NOT NULL every insert began failing
    // with nothing to show for it: the audit trail was empty and the product
    // said so nowhere.
    log.warn(
      `Could not record ${entry.action} on ${entry.entityType} ${entry.entityId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
