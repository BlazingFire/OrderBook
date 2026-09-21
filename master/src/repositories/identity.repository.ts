/**
 * Permanent id allocation, the temporary→permanent map, and the Master's own
 * HLC (docs/LEAD_GENERATION_FLOW.md §7).
 *
 * Only the Master mints permanent ids. Both counters here — the per-entity id
 * sequence and the clock — are single rows taken with `FOR UPDATE`, not
 * Postgres SEQUENCEs. That looks like a needless serialisation point until you
 * notice what a SEQUENCE gives up to be fast: it hands out numbers with gaps
 * and in whatever order sessions arrive. Permanent ids must be gap-free (they
 * are printed on dockets and read down a phone) and assigned in `(hlc, device)`
 * order, so the lock is the feature.
 */

import type { SyncableEntity } from '@orderbook/shared';
import { formatPermanentId, initialHlcState, observeHlc, tickHlc } from '@orderbook/shared';
import type { Knex } from 'knex';

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
  const [row] = await trx('id_sequences')
    .where({ tenant_id: tenantId, entity })
    .forUpdate()
    .select<Array<{ next_value: string }>>('next_value');

  // A tenant created after the migration has no counter row yet.
  if (!row) {
    await trx('id_sequences').insert({ tenant_id: tenantId, entity, next_value: 2 });
    return formatPermanentId(entity, 1);
  }

  const sequence = Number(row.next_value);
  await trx('id_sequences')
    .where({ tenant_id: tenantId, entity })
    .update({ next_value: sequence + 1 });

  return formatPermanentId(entity, sequence);
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
