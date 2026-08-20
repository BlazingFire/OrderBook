import type { Paginated, Party, PartyInput } from '@orderbook/shared';
import { v4 as uuid } from 'uuid';

import { db } from '../db/knex.js';
import { firstCount, mapParty } from './mappers.js';

const TABLE = 'parties';

export async function listParties(options: {
  search?: string;
  limit: number;
  offset: number;
}): Promise<Paginated<Party>> {
  const base = db()(TABLE).where({ is_active: true });

  if (options.search) {
    const pattern = `%${options.search}%`;
    base.andWhere((builder) =>
      builder
        .whereILike('name', pattern)
        .orWhereILike('phone', pattern)
        .orWhereILike('party_code', pattern),
    );
  }

  const countRows = await base.clone().clearOrder().count<{ count: string }[]>('id as count');
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

export async function findPartyById(id: string): Promise<Party | null> {
  const row = await db()(TABLE).where({ id }).first();
  return row ? mapParty(row) : null;
}

export async function insertParty(input: PartyInput, createdByUserId: string | null): Promise<Party> {
  // nextval() rather than MAX(code)+1: two Office Panels can create a party in
  // the same instant, and the sequence guarantees distinct codes regardless.
  const { rows } = await db().raw<{ rows: [{ code: string }] }>(
    `SELECT 'P-' || lpad(nextval('party_code_seq')::text, 4, '0') AS code`,
  );
  const partyCode = rows[0].code;

  const [row] = await db()(TABLE)
    .insert({
      id: uuid(),
      party_code: partyCode,
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
      created_by_user_id: createdByUserId,
    })
    .returning('*');

  return mapParty(row);
}

export async function updateParty(id: string, input: PartyInput): Promise<Party | null> {
  const [row] = await db()(TABLE)
    .where({ id })
    .update({
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
      updated_at: db().fn.now(),
    })
    .returning('*');

  return row ? mapParty(row) : null;
}

export async function countParties(): Promise<number> {
  const rows = await db()(TABLE)
    .where({ is_active: true })
    .count<{ count: string }[]>('id as count');
  return firstCount(rows);
}
