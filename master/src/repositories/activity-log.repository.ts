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
 *
 * **Lock order.** The entry is the *last* statement of its transaction, after
 * `master_clock` (`nextHlc`) and whatever rows the change locks. So a
 * transaction holding the chain lock is only ever waiting to commit — never on
 * a lock that somebody queued behind it holds — and two audited writes cannot
 * deadlock over it. Writing the entry first and then touching more rows would
 * break that.
 */

import type { ActivityActor, ActivityLogEntry, ActivityLogFacets, ChainBreak, ChainVerification } from '@orderbook/shared';
import type { Knex } from 'knex';

import type { ActorContext } from '../domain/actor.js';
import { config } from '../config/index.js';
import { db } from '../db/knex.js';
import type { PartyScope } from '../domain/party-scope.js';
import { partyScopeLogSql } from './party-access.repository.js';
import { createLogger } from '../lib/logger.js';
import { toJsonObject, toRequiredIso } from './mappers.js';
import type { TransactionContext } from './transaction.js';

const log = createLogger('activity');

type Runner = Knex | Knex.Transaction;

type ActorType = 'user' | 'office_panel' | 'system' | 'api_key' | 'connector';

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
 *
 * `actor` is the middle parameter (`(entry, actor, trx)`), taken from the same
 * `ActorContext` the caller already holds, so `actor_name` never needs a
 * separate join at read time. The parameter landed in Stage 1 of
 * `docs/backend-modules/`, ahead of the column it feeds — every module built
 * between Stage 1 and Stage 4 already supplied it, harmlessly unpersisted,
 * so nothing needed sweeping when `20260310000000_activity_log_actor_name`
 * (Stage 4) added `activity_log.actor_name` and this function started
 * writing it.
 */
export async function recordActivity(
  entry: ActivityEntry,
  actor: ActorContext,
  trx: TransactionContext,
): Promise<void> {
  await trx('activity_log').insert({
    tenant_id: entry.tenantId,
    entity_type: entry.entityType,
    entity_id: entry.entityId,
    action: entry.action,
    actor_type: entry.actorType,
    actor_id: entry.actorId,
    actor_name: actor.actorName,
    details: entry.details ? JSON.stringify(entry.details) : null,
  });
}

/**
 * Append an entry that has no transaction to belong to.
 *
 * The rule: a change the Master makes to its own data records its entry with
 * `recordActivity`, inside that change's transaction. This is for the entries
 * that have no such transaction, and there are three kinds today:
 *
 *  - an **attempt**, recorded the same way whether it was refused or let in —
 *    a sign-in (`auth.service.ts`). A refused one changed nothing, so there is
 *    nothing to be atomic with, and throwing would replace a useful entry with
 *    a confusing 500;
 *  - a **run that spans many transactions** — a connector import
 *    (`connector-run.service.ts`) — whose one entry summarises all of them and
 *    is written after the last;
 *  - a change that **already happened on another machine** before the Master
 *    writes its half — reissuing a panel's secret, moving a panel's storage
 *    (`panel.service.ts`). Rolling the Master's half back because the entry
 *    failed would leave the two machines disagreeing — a panel holding a secret
 *    the Master no longer accepts — which is worse than the gap.
 *
 * It swallows its own failure into a warning, which is exactly what makes it
 * wrong for anything else. If you are reaching for this from a service that has
 * a transaction open, you want that one.
 */
export async function recordDetachedActivity(
  entry: ActivityEntry,
  actor: ActorContext,
  runner: { transaction: <T>(handler: (trx: TransactionContext) => Promise<T>) => Promise<T> },
): Promise<void> {
  try {
    await runner.transaction((trx) => recordActivity(entry, actor, trx));
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

// --- Logs read side (Stage 4, docs/backend-modules/) ------------------------

interface LogRow {
  id: string;
  sequence: string | null;
  tenant_id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  actor_type: string;
  actor_id: string | null;
  actor_name: string | null;
  details: unknown;
  created_at: Date;
  hash: string | null;
}

function mapLogEntry(row: LogRow): ActivityLogEntry {
  const chained = row.hash !== null && row.hash !== 'pre-chain';
  return {
    id: String(row.id),
    sequence: row.sequence,
    tenantId: String(row.tenant_id),
    entityType: row.entity_type,
    entityId: row.entity_id,
    action: row.action,
    actor: { type: row.actor_type as ActivityActor['type'], id: row.actor_id, name: row.actor_name },
    details: toJsonObject(row.details),
    createdAt: toRequiredIso(row.created_at),
    hash: chained ? row.hash : null,
    chained,
  };
}

export interface ListLogsOptions {
  scope: PartyScope;
  actorType?: string;
  actorId?: string;
  entityType?: string;
  action?: string;
  /** 'YYYY-MM-DD', inclusive — converted to a half-open `[from, to+1)` range against `config.locale.timeZone`. */
  from?: string;
  to?: string;
  q?: string;
  direction: 'older' | 'newer';
  /** From `decodeLogCursor` — absent means "start from the newest row". */
  afterId?: string;
  limit: number;
}

export interface ListLogsResult {
  entries: ActivityLogEntry[];
  hasMore: boolean;
}

/**
 * Newest-first, keyset-paginated on `id` (BIGSERIAL, monotonic, unique) —
 * the only safe key. `sequence` is nullable and not unique; `created_at`
 * ties under `now()` within a transaction and has no unique index.
 *
 * `direction: 'newer'` walks `id > cursor ASC`, then the result is reversed
 * here so the caller always receives newest-first, matching `'older'`.
 */
export async function listEntries(
  tenantId: string,
  options: ListLogsOptions,
  runner: Runner = db(),
): Promise<ListLogsResult> {
  const bindings: Array<string | number> = [tenantId];
  let where = 'tenant_id = ?';

  // Applied first, before the caller's own filters, so no combination of
  // filters can reach an entry about somebody else's party.
  const partyScope = partyScopeLogSql(tenantId, options.scope);
  where += partyScope.sql;
  bindings.push(...partyScope.bindings);

  if (options.actorType) {
    where += ' AND actor_type = ?';
    bindings.push(options.actorType);
  }
  if (options.actorId) {
    where += ' AND actor_id = ?';
    bindings.push(options.actorId);
  }
  if (options.entityType) {
    where += ' AND entity_type = ?';
    bindings.push(options.entityType);
  }
  if (options.action) {
    where += ' AND action = ?';
    bindings.push(options.action);
  }
  if (options.from) {
    where += " AND created_at >= (?::timestamp AT TIME ZONE ?)";
    bindings.push(options.from, config.locale.timeZone);
  }
  if (options.to) {
    where += " AND created_at < ((?::date + 1)::timestamp AT TIME ZONE ?)";
    bindings.push(options.to, config.locale.timeZone);
  }
  if (options.q) {
    where += ' AND (entity_id ILIKE ? OR details::text ILIKE ?)';
    bindings.push(`%${options.q}%`, `%${options.q}%`);
  }

  const older = options.direction !== 'newer';
  if (options.afterId) {
    where += older ? ' AND id < ?' : ' AND id > ?';
    bindings.push(options.afterId);
  }

  const fetch = options.limit + 1;
  bindings.push(fetch);

  const { rows } = await runner.raw<{ rows: LogRow[] }>(
    `SELECT id, sequence, tenant_id, entity_type, entity_id, action, actor_type, actor_id, actor_name, details, created_at, hash
       FROM activity_log
      WHERE ${where}
      ORDER BY id ${older ? 'DESC' : 'ASC'}
      LIMIT ?`,
    bindings,
  );

  const hasMore = rows.length > options.limit;
  const page = hasMore ? rows.slice(0, options.limit) : rows;
  if (!older) page.reverse();

  return { entries: page.map(mapLogEntry), hasMore };
}

/**
 * Everything the trail holds about one Office Panel, both directions.
 *
 * A panel appears in two roles and an administrator wants to see both on one
 * screen: as the **actor** on work raised at that desk, and as the **subject**
 * of what somebody did to it from the Master — paired, renamed, secret
 * reissued, revoked. `listEntries` can filter on either, never on their union,
 * and running it twice would return two pages that cannot be merged without
 * inventing a cursor. So this is its own query.
 *
 * Deliberately unpaged: it answers "what has this panel been up to lately",
 * and the Logs screen is where an unbounded search belongs.
 */
export async function listPanelActivity(
  tenantId: string,
  panelId: string,
  limit: number,
  runner: Runner = db(),
): Promise<ActivityLogEntry[]> {
  const { rows } = await runner.raw<{ rows: LogRow[] }>(
    `SELECT id, sequence, tenant_id, entity_type, entity_id, action, actor_type, actor_id, actor_name, details, created_at, hash
       FROM activity_log
      WHERE tenant_id = ?
        AND ((actor_type = 'office_panel' AND actor_id = ?) OR (entity_type = 'office_panel' AND entity_id = ?))
      ORDER BY id DESC
      LIMIT ?`,
    [tenantId, panelId, panelId, limit],
  );

  return rows.map(mapLogEntry);
}

/** Populates the filter dropdowns. `action` is free-form TEXT, so this is the only way to enumerate values. */
export async function listFacets(
  tenantId: string,
  options: { from?: string; to?: string; scope: PartyScope },
  runner: Runner = db(),
): Promise<ActivityLogFacets> {
  const bindings: Array<string | number> = [tenantId];
  let where = 'tenant_id = ?';

  // The dropdowns are built from the rows the caller can actually see. An
  // unscoped facet list would name every actor in the company on a screen whose
  // rows are narrowed — which is its own small disclosure.
  const partyScope = partyScopeLogSql(tenantId, options.scope);
  where += partyScope.sql;
  bindings.push(...partyScope.bindings);

  if (options.from) {
    where += ' AND created_at >= (?::timestamp AT TIME ZONE ?)';
    bindings.push(options.from, config.locale.timeZone);
  }
  if (options.to) {
    where += ' AND created_at < ((?::date + 1)::timestamp AT TIME ZONE ?)';
    bindings.push(options.to, config.locale.timeZone);
  }

  const { rows: actorRows } = await runner.raw<{
    rows: Array<{ actor_type: string; actor_id: string | null; actor_name: string | null }>;
  }>(
    `SELECT DISTINCT actor_type, actor_id, actor_name FROM activity_log WHERE ${where}`,
    bindings,
  );
  const { rows: entityRows } = await runner.raw<{ rows: Array<{ entity_type: string }> }>(
    `SELECT DISTINCT entity_type FROM activity_log WHERE ${where}`,
    bindings,
  );
  const { rows: actionRows } = await runner.raw<{ rows: Array<{ action: string }> }>(
    `SELECT DISTINCT action FROM activity_log WHERE ${where}`,
    bindings,
  );

  return {
    actors: actorRows.map((row) => ({
      type: row.actor_type as ActivityActor['type'],
      id: row.actor_id,
      name: row.actor_name,
    })),
    entityTypes: entityRows.map((row) => row.entity_type),
    actions: actionRows.map((row) => row.action),
  };
}

export interface ChainBounds {
  minSequence: string | null;
  maxSequence: string | null;
}

/** The tenant's lowest and highest `sequence` — where a full-range verification starts and ends. */
export async function chainBounds(tenantId: string, runner: Runner = db()): Promise<ChainBounds> {
  const row = await runner('activity_log')
    .where({ tenant_id: tenantId })
    .min({ min_sequence: 'sequence' })
    .max({ max_sequence: 'sequence' })
    .first<{ min_sequence: string | null; max_sequence: string | null }>();

  return {
    minSequence: row?.min_sequence ?? null,
    maxSequence: row?.max_sequence ?? null,
  };
}

/**
 * Re-walks the chain **in SQL** — the digest covers `details::text`,
 * Postgres's own JSONB rendering, which Node cannot reproduce. Runs in its
 * own read-only transaction with a statement timeout, entirely separate
 * from the write path's advisory lock, so verification never queues behind
 * (or ahead of) an audited write.
 */
export async function verifyChain(
  tenantId: string,
  window: { fromSequence: string; toSequence: string },
): Promise<ChainVerification> {
  return db().transaction(
    async (trx) => {
      await trx.raw("SET LOCAL statement_timeout = '30s'");

      const { rows } = await trx.raw<{
        rows: Array<{
          id: string;
          sequence: string;
          prev_hash: string;
          hash: string;
          entity_type: string;
          entity_id: string;
          action: string;
          actor_type: string;
          actor_id: string | null;
          details: unknown;
          created_at: Date;
          recomputed: string;
        }>;
      }>(
        `SELECT id, sequence, prev_hash, hash, entity_type, entity_id, action, actor_type, actor_id, details, created_at,
                activity_log_row_hash(prev_hash, sequence, entity_type, entity_id, action, actor_type, actor_id, details) AS recomputed
           FROM activity_log
          WHERE tenant_id = ? AND sequence >= ? AND sequence <= ? AND hash <> 'pre-chain'
          ORDER BY sequence ASC`,
        [tenantId, window.fromSequence, window.toSequence],
      );

      const { rows: preChainRows } = await trx.raw<{ rows: [{ count: string }] }>(
        `SELECT count(*) AS count FROM activity_log
          WHERE tenant_id = ? AND sequence >= ? AND sequence <= ? AND hash = 'pre-chain'`,
        [tenantId, window.fromSequence, window.toSequence],
      );

      let firstBreak: ChainBreak | null = null;
      let previousHash: string | null = null;

      // The predecessor of the window's first chained row seeds `previousHash`
      // rather than assuming genesis — a partial range does not start at the
      // beginning of the chain.
      const firstRow = rows[0];
      if (firstRow) {
        const seed = await trx('activity_log')
          .where({ tenant_id: tenantId })
          .andWhere('sequence', '<', firstRow.sequence)
          .andWhereNot('hash', 'pre-chain')
          .orderBy('sequence', 'desc')
          .first<{ hash: string } | undefined>('hash');
        previousHash = seed?.hash ?? null;
      }

      for (const row of rows) {
        if (row.hash !== row.recomputed) {
          firstBreak = {
            kind: 'hash_mismatch',
            sequence: row.sequence,
            id: row.id,
            createdAt: toRequiredIso(row.created_at),
          };
          break;
        }
        if (previousHash !== null && row.prev_hash !== previousHash) {
          firstBreak = {
            kind: 'prev_hash_mismatch',
            sequence: row.sequence,
            id: row.id,
            createdAt: toRequiredIso(row.created_at),
          };
          break;
        }
        previousHash = row.hash;
      }

      return {
        ok: firstBreak === null,
        checkedCount: rows.length,
        skippedPreChainCount: Number(preChainRows[0]?.count ?? 0),
        fromSequence: rows[0]?.sequence ?? null,
        toSequence: rows.at(-1)?.sequence ?? null,
        firstBreak,
        truncated: false,
      };
    },
    // Read-only: the transaction does nothing but SELECT.
    { readOnly: true },
  );
}

export interface ExportLogsOptions {
  scope: PartyScope;
  actorType?: string;
  actorId?: string;
  entityType?: string;
  action?: string;
  from?: string;
  to?: string;
  q?: string;
}

/**
 * Batched export reader — a different function from `chainBounds`, not an
 * alias for it. Reads newest-first in fixed-size batches so the caller can
 * stream a CSV without holding the full result set in memory.
 */
export async function* streamForExport(
  tenantId: string,
  options: ExportLogsOptions,
  batchSize: number,
  hardCap: number,
): AsyncGenerator<ActivityLogEntry[]> {
  let afterId: string | undefined;
  let emitted = 0;

  for (;;) {
    const remaining = hardCap - emitted;
    if (remaining <= 0) return;

    const { entries, hasMore } = await listEntries(tenantId, {
      ...options,
      direction: 'older',
      afterId,
      limit: Math.min(batchSize, remaining),
    });

    if (entries.length === 0) return;

    yield entries;
    emitted += entries.length;
    afterId = entries.at(-1)?.id;

    if (!hasMore) return;
  }
}
