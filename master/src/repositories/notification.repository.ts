/**
 * `user_notifications`: one row is one notice for one person (the bell, 1.3).
 *
 * Every read and write names both the company and the person, so a caller can
 * only ever reach its own rows. The writes run on the pool and take no
 * transaction: a notice is stored after the business change it describes has
 * committed (`notification.service.ts`).
 */

import type { NotificationKind, NotificationLink, UserNotification } from '@orderbook/shared';

import { db } from '../db/knex.js';
import { toJsonObject, toRequiredIso, toIso } from './mappers.js';
import type { TransactionContext } from './transaction.js';

const TABLE = 'user_notifications';

/** Read notices older than this are pruned. */
const KEEP_READ_DAYS = 60;
/** Each person keeps at most this many notices, newest first. */
const KEEP_PER_USER = 500;

type Row = Record<string, unknown>;

function mapNotification(row: Row): UserNotification {
  return {
    id: String(row.id),
    kind: String(row.kind) as NotificationKind,
    params: toJsonObject(row.params) as UserNotification['params'],
    link: (row.link as NotificationLink | null) ?? null,
    createdAt: toRequiredIso(row.created_at),
    readAt: toIso(row.read_at),
  };
}

/**
 * Store one notice for each person, skipping anyone who already has an unread
 * notice with the same `dedupeKey` (the partial unique index decides, so two
 * notices racing each other cannot both land). Returns the rows actually added.
 */
export async function insertNotifications(
  tenantId: string,
  userIds: readonly string[],
  input: {
    kind: NotificationKind;
    params: Record<string, unknown>;
    link: NotificationLink | null;
    dedupeKey: string | null;
  },
): Promise<Array<{ userId: string; notification: UserNotification }>> {
  if (userIds.length === 0) return [];

  const rows: Row[] = await db()(TABLE)
    .insert(
      userIds.map((userId) => ({
        tenant_id: tenantId,
        user_id: userId,
        kind: input.kind,
        params: JSON.stringify(input.params),
        link: input.link ? JSON.stringify(input.link) : null,
        dedupe_key: input.dedupeKey,
      })),
    )
    .onConflict(
      db().raw(
        '(tenant_id, user_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND read_at IS NULL',
      ),
    )
    .ignore()
    .returning('*');

  return rows.map((row) => ({ userId: String(row.user_id), notification: mapNotification(row) }));
}

/**
 * One person's notices, newest first. `before` pages back: it is compared at
 * millisecond precision because that is all the ISO `createdAt` a client hands
 * back carries, and comparing the stored microseconds against it would repeat
 * the last row of the previous page.
 */
export async function listForUser(
  tenantId: string,
  userId: string,
  page: { limit: number; before: string | null },
): Promise<UserNotification[]> {
  const query = db()(TABLE)
    .where({ tenant_id: tenantId, user_id: userId })
    .orderBy([
      { column: 'created_at', order: 'desc' },
      { column: 'id', order: 'desc' },
    ])
    .limit(page.limit);
  if (page.before) query.whereRaw(`date_trunc('milliseconds', created_at) < ?`, [page.before]);

  return ((await query) as Row[]).map(mapNotification);
}

export async function countUnread(tenantId: string, userId: string): Promise<number> {
  const row = await db()(TABLE)
    .where({ tenant_id: tenantId, user_id: userId })
    .whereNull('read_at')
    .count<{ count: string }>('* as count')
    .first();
  return Number(row?.count ?? 0);
}

/** Mark the named notices (or, with `'all'`, every one) read. Already-read rows keep their time. */
export async function markRead(
  tenantId: string,
  userId: string,
  which: readonly string[] | 'all',
): Promise<void> {
  if (which !== 'all' && which.length === 0) return;

  const query = db()(TABLE)
    .where({ tenant_id: tenantId, user_id: userId })
    .whereNull('read_at');
  if (which !== 'all') query.whereIn('id', which);
  await query.update({ read_at: db().fn.now() });
}

/**
 * Drop read notices older than `KEEP_READ_DAYS`, and everything past each
 * person's newest `KEEP_PER_USER`. Returns how many rows went.
 */
export async function prune(): Promise<number> {
  const old = await db()(TABLE)
    .whereNotNull('read_at')
    .where('read_at', '<', db().raw(`now() - make_interval(days => ?)`, [KEEP_READ_DAYS]))
    .delete();

  const extra = await db().raw(
    `DELETE FROM ${TABLE} n
      USING (
        SELECT id FROM (
          SELECT id, row_number() OVER (
            PARTITION BY tenant_id, user_id ORDER BY created_at DESC, id DESC
          ) AS position
          FROM ${TABLE}
        ) ranked
        WHERE position > ?
      ) surplus
      WHERE n.id = surplus.id`,
    [KEEP_PER_USER],
  );

  return old + Number((extra as { rowCount?: number }).rowCount ?? 0);
}

/**
 * Delete every notice of the restored companies (all of them when `tenantIds`
 * is null). Notices are not in a backup and name user ids a restore may give
 * to somebody else, so a restore clears them as it clears the vault.
 */
export async function clearNotifications(trx: TransactionContext, tenantIds: string[] | null): Promise<number> {
  const query = trx(TABLE);
  if (tenantIds) query.whereIn('tenant_id', tenantIds);
  return query.delete();
}
