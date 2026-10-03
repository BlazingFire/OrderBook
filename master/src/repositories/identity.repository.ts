/**
 * Permanent id allocation, pending order numbers, the temporary→permanent map,
 * and the Master's own HLC (docs/LEAD_GENERATION_FLOW.md §7).
 *
 * Only the Master mints permanent ids. Both counters here — the `id_sequences`
 * series and the clock — are single rows held under a row lock, not
 * Postgres SEQUENCEs. That looks like a needless serialisation point until you
 * notice what a SEQUENCE gives up to be fast: it hands out numbers with gaps
 * and in whatever order sessions arrive. Permanent ids must be gap-free (they
 * are printed on dockets and read down a phone) and assigned in `(hlc, device)`
 * order, so the lock is the feature.
 */

import type { SyncableEntity } from '@orderbook/shared';
import {
  financialYearLabel,
  formatPendingOrderNumber,
  formatPermanentId,
  initialHlcState,
  observeHlc,
  tickHlc,
} from '@orderbook/shared';
import type { Knex } from 'knex';

import { config } from '../config/index.js';
import { db } from '../db/knex.js';
import type { TransactionContext } from './transaction.js';

/** The Master's device code. Fixed, and never a valid panel code. */
const MASTER_DEVICE_CODE = 'MASTER';

type Runner = Knex | Knex.Transaction;

/**
 * Take the next id for an entity within a tenant.
 *
 * Must run inside a transaction: the row lock is what stops two panels syncing
 * at once from being handed the same number.
 */
export async function allocatePermanentId(
  tenantId: string,
  entity: SyncableEntity,
  trx: TransactionContext,
): Promise<string> {
  return formatPermanentId(entity, await nextInSeries(tenantId, entity, trx));
}

/**
 * The next number of one `id_sequences` series: an entity's ids, or a
 * `po:<fy>` pending order series. Gap-free: the UPDATE holds the row's lock to
 * the end of the caller's transaction, so a second caller waits, and a
 * rollback takes the number back. A series with no row yet starts at 1.
 */
export async function nextInSeries(tenantId: string, key: string, trx: TransactionContext): Promise<number> {
  await trx.raw(
    `INSERT INTO id_sequences (tenant_id, entity, next_value) VALUES (?, ?, 1)
     ON CONFLICT (tenant_id, entity) DO NOTHING`,
    [tenantId, key],
  );
  const { rows } = await trx.raw<{ rows: Array<{ value: string }> }>(
    `UPDATE id_sequences SET next_value = next_value + 1
      WHERE tenant_id = ? AND entity = ?
      RETURNING next_value - 1 AS value`,
    [tenantId, key],
  );
  return Number(rows[0]!.value);
}

/**
 * The PO number for a lead created at `createdAt` (`PO/2026-27/00042`), from
 * the series of the financial year that instant falls in, in the company's
 * time zone. Called inside the transaction that inserts the lead, so a create
 * that fails takes its number back with it.
 */
export async function allocatePendingOrderNumber(
  tenantId: string,
  createdAt: Date,
  trx: TransactionContext,
): Promise<string> {
  const year = financialYearLabel(createdAt, config.locale.timeZone);
  return formatPendingOrderNumber(year, await nextInSeries(tenantId, `po:${year}`, trx));
}

/**
 * Give every lead without a PO number one, and set the `po:<fy>` counters past
 * them. A frozen copy of steps 2 and 4 of
 * `20261003000000_pending_order_numbers.ts`, for a restore that brings back
 * leads from before that migration: it has already run on this database, so
 * nothing else would number them. Copied rather than imported, because a
 * migration must not change when this does. Safe to run on any database: it
 * touches only leads with no number.
 */
export async function backfillPendingOrderNumbers(trx: TransactionContext): Promise<void> {
  await trx.raw(`
    WITH src AS (
      SELECT id, tenant_id, created_at,
             (CASE WHEN EXTRACT(MONTH FROM created_at AT TIME ZONE 'Asia/Kolkata') >= 4
                   THEN EXTRACT(YEAR FROM created_at AT TIME ZONE 'Asia/Kolkata')
                   ELSE EXTRACT(YEAR FROM created_at AT TIME ZONE 'Asia/Kolkata') - 1 END)::int AS fy0
        FROM leads
       WHERE po_number IS NULL
    ), labelled AS (
      SELECT id, tenant_id, created_at, fy0 || '-' || lpad(((fy0 + 1) % 100)::text, 2, '0') AS fy
        FROM src
    ), base AS (
      SELECT tenant_id, fy, max(top) AS top
        FROM (SELECT tenant_id, split_part(po_number, '/', 2) AS fy, split_part(po_number, '/', 3)::bigint AS top
                FROM leads
               WHERE po_number IS NOT NULL
              UNION ALL
              SELECT tenant_id, substring(entity from 4) AS fy, next_value - 1 AS top
                FROM id_sequences
               WHERE entity LIKE 'po:%') taken
       GROUP BY tenant_id, fy
    ), numbered AS (
      SELECT l.id, l.tenant_id, l.fy,
             coalesce(b.top, 0) + row_number() OVER (PARTITION BY l.tenant_id, l.fy ORDER BY l.created_at, l.id) AS n
        FROM labelled l
        LEFT JOIN base b ON b.tenant_id = l.tenant_id AND b.fy = l.fy
    )
    UPDATE leads
       SET po_number = 'PO/' || numbered.fy || '/' || lpad(numbered.n::text, greatest(5, length(numbered.n::text)), '0')
      FROM numbered
     WHERE leads.id = numbered.id AND leads.tenant_id = numbered.tenant_id`);
  await trx.raw(`
    INSERT INTO id_sequences (tenant_id, entity, next_value)
    SELECT tenant_id, 'po:' || split_part(po_number, '/', 2), max(split_part(po_number, '/', 3)::bigint) + 1
      FROM leads
     WHERE po_number IS NOT NULL
     GROUP BY tenant_id, split_part(po_number, '/', 2)
    ON CONFLICT (tenant_id, entity) DO UPDATE
      SET next_value = greatest(id_sequences.next_value, EXCLUDED.next_value)`);
}

/** Allocate a contiguous block — one query per batch instead of per record. */
export async function allocatePermanentIds(
  tenantId: string,
  entity: SyncableEntity,
  count: number,
  trx: TransactionContext,
): Promise<string[]> {
  if (count <= 0) return [];

  const [row] = await trx('id_sequences')
    .where({ tenant_id: tenantId, entity })
    .forUpdate()
    .select<Array<{ next_value: string }>>('next_value');

  const start = row ? Number(row.next_value) : 1;

  if (row) {
    await trx('id_sequences')
      .where({ tenant_id: tenantId, entity })
      .update({ next_value: start + count });
  } else {
    await trx('id_sequences').insert({ tenant_id: tenantId, entity, next_value: start + count });
  }

  return Array.from({ length: count }, (_, index) => formatPermanentId(entity, start + index));
}

export async function recordIdMapping(
  mapping: {
    tenantId: string;
    entity: string;
    temporaryId: string;
    permanentId: string;
    deviceCode: string;
  },
  trx: TransactionContext,
): Promise<void> {
  await trx('id_map')
    .insert({
      tenant_id: mapping.tenantId,
      entity: mapping.entity,
      temporary_id: mapping.temporaryId,
      permanent_id: mapping.permanentId,
      device_code: mapping.deviceCode,
    })
    // A replayed batch re-asserts the same mapping; that is not an error.
    .onConflict(['tenant_id', 'temporary_id'])
    .ignore();
}

/**
 * Resolve whatever id a caller has to the one the record lives under.
 *
 * The temporary id keeps working forever, which is the whole point — a lead
 * printed while offline is still findable after it was renumbered.
 */
export async function resolveId(
  tenantId: string,
  id: string,
  runner: Runner = db(),
): Promise<string> {
  const row = await runner('id_map')
    .where({ tenant_id: tenantId, temporary_id: id })
    .first<{ permanent_id: string } | undefined>('permanent_id');

  return row?.permanent_id ?? id;
}

export async function listIdMappings(
  tenantId: string,
  temporaryIds: string[],
  runner: Runner = db(),
): Promise<Map<string, string>> {
  if (temporaryIds.length === 0) return new Map();

  const rows = await runner('id_map')
    .where({ tenant_id: tenantId })
    .whereIn('temporary_id', temporaryIds)
    .select<Array<{ temporary_id: string; permanent_id: string }>>(
      'temporary_id',
      'permanent_id',
    );

  return new Map(rows.map((row) => [row.temporary_id, row.permanent_id]));
}

/**
 * Stamp the next HLC for a Master-originated write.
 *
 * The clock is persisted so a restart cannot rewind it — a rewound clock would
 * let a post-restart edit sort *before* one made just prior to it, silently
 * losing the newer value in a merge.
 */
export async function nextHlc(trx: TransactionContext, now = Date.now()): Promise<string> {
  const state = await lockClock(trx);
  const { state: next, hlc } = tickHlc(state, now);
  await saveClock(trx, next);
  return hlc;
}

/** Fold a panel's timestamp into the Master's clock, then stamp our own. */
export async function observeAndNextHlc(
  trx: TransactionContext,
  remoteHlc: string,
  now = Date.now(),
): Promise<string> {
  const state = await lockClock(trx);
  const { state: next, hlc } = observeHlc(state, remoteHlc, now);
  await saveClock(trx, next);
  return hlc;
}

/**
 * A preview of what `nextHlc`/`observeAndNextHlc` would stamp right now —
 * unlocked and never persisted, so calling it does not advance the real
 * clock. Safe only as an advisory value folded into a panel's own clock
 * (`SyncPushResponse.serverHlc` and friends); it must never be used to stamp
 * a row, because two calls made close together (or one followed immediately
 * by a real `nextHlc`) can return colliding or non-monotonic values.
 */
export async function peekHlc(runner: Runner = db()): Promise<string> {
  const row = await runner('master_clock')
    .where({ id: 1 })
    .first<{ device_code: string; physical: string; counter: number } | undefined>();

  if (!row) return tickHlc(initialHlcState(MASTER_DEVICE_CODE), Date.now()).hlc;

  return tickHlc(
    {
      deviceCode: row.device_code,
      physical: Number(row.physical),
      counter: row.counter,
    },
    Date.now(),
  ).hlc;
}

async function lockClock(trx: TransactionContext) {
  const row = await trx('master_clock')
    .where({ id: 1 })
    .forUpdate()
    .first<{ device_code: string; physical: string; counter: number } | undefined>();

  if (!row) {
    const fresh = initialHlcState(MASTER_DEVICE_CODE);
    await trx('master_clock').insert({
      id: 1,
      device_code: fresh.deviceCode,
      physical: fresh.physical,
      counter: fresh.counter,
    });
    return fresh;
  }

  return {
    deviceCode: row.device_code,
    physical: Number(row.physical),
    counter: row.counter,
  };
}

async function saveClock(
  trx: TransactionContext,
  state: { physical: number; counter: number },
): Promise<void> {
  await trx('master_clock')
    .where({ id: 1 })
    .update({ physical: state.physical, counter: state.counter });
}
