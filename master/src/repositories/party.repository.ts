/**
 * Parties (customers). Syncable, so rows carry text ids and sync bookkeeping.
 */

import { columnPatch, PARTY_COLUMNS } from '@orderbook/shared';
import type {
  Paginated,
  Party,
  PartyAccessSort,
  PartyAccessSortDir,
  PartyInput,
  PartyScopeFilter,
} from '@orderbook/shared';
import type { Knex } from 'knex';

import { db } from '../db/knex.js';
import type { PartyScope } from '../domain/party-scope.js';
import { allocatePermanentId } from './identity.repository.js';
import { firstCount, mapParty } from './mappers.js';
import { applyPartyScope } from './party-access.repository.js';
import type { TransactionContext } from './transaction.js';

const TABLE = 'parties';

type Runner = Knex | Knex.Transaction;

/** 1.4 D3 (R17): the sortable columns. Looked up, never spliced; an unknown key keeps name order. */
const PARTY_SORT_SQL: Record<string, string> = {
  code: 'lower(party_code)',
  name: 'lower(name)',
  phone: 'phone',
  city: 'lower(city)',
  state: 'lower(state)',
  gst: 'lower(gst_number)',
  since: 'created_at',
  variants:
    '(SELECT count(*) FROM party_product_variants pv WHERE pv.party_id = parties.id AND pv.tenant_id = parties.tenant_id)',
};

export async function listParties(
  tenantId: string,
  options: {
    search?: string;
    sort?: string;
    dir?: string;
    city?: string;
    state?: string;
    hasGst?: boolean;
    limit: number;
    offset: number;
    scope: PartyScope;
    filter?: PartyScopeFilter;
  },
): Promise<Paginated<Party>> {
  const base = db()(TABLE).where({ tenant_id: tenantId, is_active: true }).whereNull('deleted_at');

  applyPartyScope(base, tenantId, `${TABLE}.id`, options.scope, {
    level: 'view',
    filter: options.filter,
  });

  if (options.search) {
    const pattern = `%${options.search}%`;
    base.andWhere((builder) =>
      builder
        .whereILike('name', pattern)
        .orWhereILike('phone', pattern)
        .orWhereILike('party_code', pattern),
    );
  }

  if (options.city?.trim()) base.andWhereILike('city', `%${options.city.trim()}%`);
  if (options.state?.trim()) base.andWhereILike('state', `%${options.state.trim()}%`);
  if (options.hasGst !== undefined) {
    base.andWhereRaw(
      options.hasGst ? "coalesce(trim(gst_number), '') <> ''" : "coalesce(trim(gst_number), '') = ''",
    );
  }

  const countRows = await base.clone().clearOrder().count<Array<{ count: string }>>('id as count');
  const sortSql =
    options.sort && Object.prototype.hasOwnProperty.call(PARTY_SORT_SQL, options.sort)
      ? PARTY_SORT_SQL[options.sort]
      : null;
  const ordered = base.clone();
  if (sortSql) ordered.orderByRaw(`${sortSql} ${options.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`);
  const rows = await ordered
    // `id` last: two parties may share a name, and an unordered tie lets a row
    // repeat or vanish between two pages — which an export pages through.
    .orderBy('name', 'asc')
    .orderBy('id', 'asc')
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
    // lpad truncates, so past P-9999 a fixed width would cut the code short and
    // collide; the width grows with the number instead.
    `SELECT 'P-' || lpad(s::text, greatest(4, length(s::text)), '0') AS code
       FROM (SELECT nextval('party_code_seq') AS s) n`,
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

export async function countParties(tenantId: string, scope: PartyScope): Promise<number> {
  const query = db()(TABLE)
    .where({ tenant_id: tenantId, is_active: true })
    .whereNull('deleted_at');

  applyPartyScope(query, tenantId, `${TABLE}.id`, scope, { level: 'view' });

  const rows = await query.count<Array<{ count: string }>>('id as count');
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

/**
 * The live parties the codes name, by lower-case code — what a bulk update
 * matches its rows against. Soft-deleted parties are not matched: their code
 * is free again.
 */
export async function findLivePartiesByCodes(
  tenantId: string,
  codes: readonly string[],
  runner: Runner = db(),
): Promise<Map<string, Party>> {
  const found = new Map<string, Party>();
  const wanted = [...new Set(codes.map((code) => code.trim().toLowerCase()).filter(Boolean))];

  for (let at = 0; at < wanted.length; at += 1000) {
    const rows = await runner(TABLE)
      .where({ tenant_id: tenantId })
      .whereNull('deleted_at')
      .whereRaw('lower(party_code) = ANY(?)', [wanted.slice(at, at + 1000)]);
    for (const row of rows) found.set(String(row.party_code).toLowerCase(), mapParty(row));
  }

  return found;
}

/**
 * A live party's per-field clocks, read under its row lock inside the caller's
 * transaction. A bulk update merges its own stamps into **this**, not into the
 * copy it read when the file was previewed: an offline edit that landed since
 * would otherwise lose its clock and be overwritten without a trace.
 */
export async function lockPartyFieldHlc(
  tenantId: string,
  id: string,
  trx: TransactionContext,
): Promise<Record<string, string> | null> {
  const row = await trx(TABLE)
    .where({ tenant_id: tenantId, id })
    .whereNull('deleted_at')
    .forUpdate()
    .first('field_hlc');
  if (!row) return null;
  const stored = row.field_hlc;
  return (typeof stored === 'string' ? JSON.parse(stored) : stored ?? {}) as Record<string, string>;
}

/**
 * Name and city of every live party, **whoever may see it** — a bulk add must
 * skip a duplicate of a party its person has no access to, or Party Access
 * would be a way to create a second copy of somebody else's customer. Only
 * the two strings leave this function, never a row.
 */
export async function listLivePartyNameCities(
  tenantId: string,
  runner: Runner = db(),
): Promise<Array<{ name: string; city: string | null }>> {
  const rows = await runner(TABLE).where({ tenant_id: tenantId }).whereNull('deleted_at').select('name', 'city');
  return rows.map((row: Record<string, unknown>) => ({
    name: String(row.name),
    city: (row.city as string | null) ?? null,
  }));
}

/**
 * Only the columns this input actually asserts.
 *
 * This used to list every column with `?? null` and was spread straight into
 * `.update()`, which made an update a full record replace: the 5-field party
 * drawer nulled `alt_phone`, `email`, both address lines, `state` and
 * `pincode`. See the contract in `shared/src/domain/columns.ts`.
 */
function columnsFrom(input: PartyInput): Record<string, unknown> {
  return columnPatch(input, PARTY_COLUMNS);
}

// --- Party Access ----------------------------------------------------------

/** A party as the Party Access screen lists it — no scope, by design. */
export interface PartyAccessListRow {
  id: string;
  partyCode: string;
  name: string;
  city: string | null;
  version: number;
}

/**
 * The party book as an administrator sees it.
 *
 * Deliberately **not** party-scoped: the caller has already been checked for
 * `party.assign` or `party.accessAll`, and the whole purpose of the screen is
 * to show the parties they are about to divide up. The `userId` and
 * `restriction` filters are what narrow it.
 */
export async function listPartiesForAccess(
  tenantId: string,
  options: {
    search?: string;
    userId?: string;
    restriction?: 'open' | 'restricted';
    sort?: PartyAccessSort;
    dir?: PartyAccessSortDir;
    limit: number;
    offset: number;
  },
): Promise<Paginated<PartyAccessListRow>> {
  const base = db()(TABLE).where({ tenant_id: tenantId }).whereNull('deleted_at');

  /*
   * Plain text, not a LIKE pattern: a person typing `50%` or `a_b` means those
   * characters. Matches the party's code, name, city and phone, and anybody
   * assigned to it by display name or username — the question an administrator
   * asks is as often "which parties does Ravi hold" as "which party is this".
   */
  const term = options.search?.trim();
  if (term) {
    const pattern = `%${term.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
    base.andWhere((builder) =>
      builder
        .whereILike('name', pattern)
        .orWhereILike('phone', pattern)
        .orWhereILike('party_code', pattern)
        .orWhereILike('city', pattern)
        .orWhereExists((sub) =>
          sub
            .select(db().raw('1'))
            .from('party_access as pac_s')
            .join('users as pac_u', 'pac_u.id', 'pac_s.user_id')
            .where('pac_s.tenant_id', tenantId)
            .whereNull('pac_u.deleted_at')
            .whereRaw(`pac_s.party_id = ${TABLE}.id`)
            .andWhere((who) =>
              who.whereILike('pac_u.display_name', pattern).orWhereILike('pac_u.username', pattern),
            ),
        ),
    );
  }

  if (options.userId) {
    base.whereExists((sub) =>
      sub
        .select(db().raw('1'))
        .from('party_access as pac_f')
        .where('pac_f.tenant_id', tenantId)
        .where('pac_f.user_id', options.userId as string)
        .whereRaw(`pac_f.party_id = ${TABLE}.id`),
    );
  }

  if (options.restriction) {
    const anyGrant = (sub: Knex.QueryBuilder): Knex.QueryBuilder =>
      sub
        .select(db().raw('1'))
        .from('party_access as pac_r')
        .where('pac_r.tenant_id', tenantId)
        .whereRaw(`pac_r.party_id = ${TABLE}.id`);

    if (options.restriction === 'restricted') base.whereExists(anyGrant);
    else base.whereNotExists(anyGrant);
  }

  const countRows = await base.clone().clearOrder().count<Array<{ count: string }>>('id as count');
  const rows = await orderForAccess(base.clone(), tenantId, options.sort, options.dir)
    .limit(options.limit)
    .offset(options.offset)
    .select('id', 'party_code', 'name', 'city', 'version');

  return {
    items: rows.map((row: Record<string, unknown>) => ({
      id: String(row.id),
      partyCode: String(row.party_code),
      name: String(row.name),
      city: (row.city as string | null) ?? null,
      version: Number(row.version),
    })),
    total: firstCount(countRows),
    limit: options.limit,
    offset: options.offset,
  };
}

/**
 * The list's order. Every branch ends on name then id, so a page boundary never repeats or
 * drops a row whatever the column; an empty city sorts last in both directions (a blank is
 * not "before A"). `access` is the number of people assigned.
 */
function orderForAccess(
  query: Knex.QueryBuilder,
  tenantId: string,
  sort: PartyAccessSort | undefined,
  dir: PartyAccessSortDir | undefined,
): Knex.QueryBuilder {
  const direction = dir === 'desc' ? 'desc' : 'asc';

  switch (sort) {
    case 'code':
      query.orderBy('party_code', direction);
      break;
    case 'city':
      query.orderByRaw(`(city IS NULL OR btrim(city) = '') ASC`);
      query.orderByRaw(`lower(city) ${direction}`);
      break;
    case 'access':
      query.orderByRaw(
        `(SELECT count(*) FROM party_access pac_o WHERE pac_o.tenant_id = ? AND pac_o.party_id = ${TABLE}.id) ${direction}`,
        [tenantId],
      );
      break;
    case 'name':
      query.orderByRaw(`lower(name) ${direction}`);
      break;
    default:
      // No (or an unknown) sort: the order this list has always had.
      return query.orderBy('name', 'asc').orderBy('id', 'asc');
  }

  return query.orderByRaw('lower(name) ASC').orderBy('id', 'asc');
}

/** Live parties company-wide and how many of them somebody is assigned to. */
export async function partyAccessCounts(
  tenantId: string,
): Promise<{ total: number; restricted: number }> {
  const { rows } = await db().raw<{ rows: Array<{ total: string; restricted: string }> }>(
    `SELECT count(*) AS total,
            count(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM party_access pac_c
               WHERE pac_c.tenant_id = p.tenant_id AND pac_c.party_id = p.id
            )) AS restricted
       FROM ${TABLE} p
      WHERE p.tenant_id = ? AND p.deleted_at IS NULL`,
    [tenantId],
  );
  return { total: Number(rows[0]?.total ?? 0), restricted: Number(rows[0]?.restricted ?? 0) };
}

/**
 * Take the party's row lock and read its version, inside the caller's
 * transaction.
 *
 * `SELECT … FOR UPDATE` before comparing, rather than reading the version and
 * then opening a transaction: the older entities in this codebase do the
 * latter, which is a real check-then-act race under two concurrent saves. This
 * follows what Fields already does (`fieldRepo.lockOptionListItem`).
 */
export async function lockParty(
  tenantId: string,
  id: string,
  trx: TransactionContext,
): Promise<{ id: string; name: string; version: number } | null> {
  const row = await trx(TABLE)
    .where({ tenant_id: tenantId, id })
    .whereNull('deleted_at')
    .forUpdate()
    .first('id', 'name', 'version');

  if (!row) return null;
  return { id: String(row.id), name: String(row.name), version: Number(row.version) };
}

/**
 * Bump the party's version and clock without touching a business field.
 *
 * Grants live in their own table, but they are approved as part of the party,
 * so the party's version is what an optimistic save checks against — which
 * only works if changing the grants moves it.
 */
export async function touchParty(
  tenantId: string,
  id: string,
  hlc: string,
  trx: TransactionContext,
): Promise<void> {
  await trx(TABLE)
    .where({ tenant_id: tenantId, id })
    .update({
      version: trx.raw('version + 1'),
      hlc,
      updated_at: trx.fn.now(),
    });
}
