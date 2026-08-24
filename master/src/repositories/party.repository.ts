/**
 * Parties (customers). Syncable, so rows carry text ids and sync bookkeeping.
 */

import type { Paginated, Party, PartyInput } from '@orderbook/shared';
import type { Knex } from 'knex';

import { db } from '../db/knex.js';
import { allocatePermanentId } from './identity.repository.js';
import { firstCount, mapParty } from './mappers.js';
import type { TransactionContext } from './transaction.js';

const TABLE = 'parties';

type Runner = Knex | Knex.Transaction;

export async function listParties(
  tenantId: string,
  options: { search?: string; limit: number; offset: number },
): Promise<Paginated<Party>> {
  const base = db()(TABLE).where({ tenant_id: tenantId, is_active: true }).whereNull('deleted_at');

  if (options.search) {
    const pattern = `%${options.search}%`;
    base.andWhere((builder) =>
      builder
        .whereILike('name', pattern)
        .orWhereILike('phone', pattern)
        .orWhereILike('party_code', pattern),
    );
  }

  const countRows = await base.clone().clearOrder().count<Array<{ count: string }>>('id as count');
  const rows = await base
    .clone()
    .orderBy('name', 'asc')
    .limit(options.limit)
    .offset(options.offset);

  return {
    items: rows.map(mapParty),
    total: firstCount(countRows),
    limit: options.limit,
    offset: options.offset,
  };
}

export async function findPartyById(
  tenantId: string,
  id: string,
  runner: Runner = db(),
  options: { includeDeleted?: boolean } = {},
): Promise<Party | null> {
  const query = runner(TABLE).where({ tenant_id: tenantId, id });
  if (!options.includeDeleted) query.whereNull('deleted_at');
  const row = await query.first();
  return row ? mapParty(row) : null;
}

/** Restore-time collision check — over live rows only, matching the partial unique index. */
export async function isPartyCodeTaken(
  tenantId: string,
  code: string,
  excludeId: string | null,
  runner: Runner = db(),
): Promise<boolean> {
  const query = runner(TABLE).where({ tenant_id: tenantId, party_code: code }).whereNull('deleted_at');
  if (excludeId) query.whereNot({ id: excludeId });
  return (await query.first('id')) !== undefined;
}

/**
 * Soft delete, stamping `hlc`/`field_hlc.deletedAt` alongside `deleted_at` —
 * mirroring `softDeleteRole` here would bump `version` without advancing the
 * clock, leaving a state the merge engine cannot interpret
 * (`docs/backend-modules/03-DATABASE.md` §9.2).
 */
export async function softDeleteParty(
  tenantId: string,
  id: string,
  actorUserId: string | null,
  meta: { hlc: string; fieldHlc: Record<string, string> },
  trx: TransactionContext,
): Promise<Party | null> {
  const [row] = await trx(TABLE)
    .where({ tenant_id: tenantId, id })
    .whereNull('deleted_at')
    .update({
      deleted_at: trx.fn.now(),
      deleted_by: actorUserId,
      version: trx.raw('version + 1'),
      hlc: meta.hlc,
      field_hlc: JSON.stringify(meta.fieldHlc),
      updated_at: trx.fn.now(),
    })
    .returning('*');

  return row ? mapParty(row) : null;
}

export async function restoreParty(
  tenantId: string,
  id: string,
  meta: { hlc: string; fieldHlc: Record<string, string> },
  trx: TransactionContext,
  renameCode?: string,
): Promise<Party | null> {
  const [row] = await trx(TABLE)
    .where({ tenant_id: tenantId, id })
    .whereNotNull('deleted_at')
    .update({
      deleted_at: null,
      deleted_by: null,
      ...(renameCode ? { party_code: renameCode } : {}),
      version: trx.raw('version + 1'),
      hlc: meta.hlc,
      field_hlc: JSON.stringify(meta.fieldHlc),
      updated_at: trx.fn.now(),
    })
    .returning('*');

  return row ? mapParty(row) : null;
}

export interface NewParty {
  tenantId: string;
  input: PartyInput;
  createdByUserId: string | null;
  hlc: string;
  fieldHlc: Record<string, string>;
  temporaryId: string | null;
  id?: string;
}

export async function insertParty(party: NewParty, trx: TransactionContext): Promise<Party> {
  const id = party.id ?? (await allocatePermanentId(party.tenantId, 'party', trx));

  // nextval() rather than MAX(code)+1: two Office Panels can create a party in
  // the same instant, and the sequence guarantees distinct codes regardless.
  const { rows } = await trx.raw<{ rows: [{ code: string }] }>(
    `SELECT 'P-' || lpad(nextval('party_code_seq')::text, 4, '0') AS code`,
  );

  const [row] = await trx(TABLE)
    .insert({
      id,
      tenant_id: party.tenantId,
      party_code: rows[0].code,
      ...columnsFrom(party.input),
      created_by_user_id: party.createdByUserId,
      hlc: party.hlc,
      field_hlc: JSON.stringify(party.fieldHlc),
      temporary_id: party.temporaryId,
    })
    .returning('*');

  return mapParty(row);
}

export async function updateParty(
  tenantId: string,
  id: string,
  input: PartyInput,
  meta: { hlc: string; fieldHlc: Record<string, string> },
  trx: TransactionContext,
): Promise<Party | null> {
  const [row] = await trx(TABLE)
    .where({ tenant_id: tenantId, id })
    .update({
      ...columnsFrom(input),
      hlc: meta.hlc,
      field_hlc: JSON.stringify(meta.fieldHlc),
      version: trx.raw('version + 1'),
      updated_at: trx.fn.now(),
    })
    .returning('*');

  return row ? mapParty(row) : null;
}

/** Apply an already-merged column patch, without touching untouched fields. */
export async function updatePartyColumns(
  tenantId: string,
  id: string,
  patch: Record<string, unknown>,
  meta: { hlc: string; fieldHlc: Record<string, string> },
  trx: TransactionContext,
): Promise<void> {
  await trx(TABLE)
    .where({ tenant_id: tenantId, id })
    .update({
      ...patch,
      hlc: meta.hlc,
      field_hlc: JSON.stringify(meta.fieldHlc),
      version: trx.raw('version + 1'),
      updated_at: trx.fn.now(),
    });
}

export async function countParties(tenantId: string): Promise<number> {
  const rows = await db()(TABLE)
    .where({ tenant_id: tenantId, is_active: true })
    .whereNull('deleted_at')
    .count<Array<{ count: string }>>('id as count');
  return firstCount(rows);
}

/**
 * What blocks deleting this party — any LIVE lead or order that still points
 * at it. A converted lead's order also references the party directly, so
 * checking both tables (rather than leads alone) is what catches that case
 * without special-casing conversion.
 */
export async function liveReferencesToParty(
  tenantId: string,
  partyId: string,
  runner: Runner = db(),
): Promise<Array<{ entityType: 'lead' | 'order'; id: string; label: string }>> {
  const [leads, orders] = await Promise.all([
    runner('leads')
      .where({ tenant_id: tenantId, party_id: partyId })
      .whereNull('deleted_at')
      .select<Array<{ id: string }>>('id'),
    runner('orders')
      .where({ tenant_id: tenantId, party_id: partyId })
      .whereNull('deleted_at')
      .select<Array<{ id: string }>>('id'),
  ]);

  return [
    ...leads.map((row) => ({ entityType: 'lead' as const, id: row.id, label: row.id })),
    ...orders.map((row) => ({ entityType: 'order' as const, id: row.id, label: row.id })),
  ];
}

function columnsFrom(input: PartyInput): Record<string, unknown> {
  return {
    name: input.name,
    phone: input.phone ?? null,
    alt_phone: input.altPhone ?? null,
    email: input.email ?? null,
    address_line1: input.addressLine1 ?? null,
    address_line2: input.addressLine2 ?? null,
    city: input.city ?? null,
    state: input.state ?? null,
    pincode: input.pincode ?? null,
    gst_number: input.gstNumber ?? null,
    notes: input.notes ?? null,
    custom_fields: JSON.stringify(input.customFields ?? {}),
  };
}
