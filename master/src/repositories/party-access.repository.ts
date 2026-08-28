/**
 * Party assignments, and the one SQL predicate that enforces them.
 *
 * `applyPartyScope` is the load-bearing export: every read path that can reach
 * a party — leads, orders, the party list itself, search, the dashboard,
 * reports, the recycle bin, the activity log, party variants — narrows through
 * it, so the rule lives in one place instead of being re-expressed nine times
 * with nine chances to get the unassigned case backwards.
 */

import type {
  PartyAccessAssignee,
  PartyAccessEntry,
  PartyAccessLevel,
  PartyScopeFilter,
} from '@orderbook/shared';
import type { Knex } from 'knex';

import { db } from '../db/knex.js';
import type { PartyScope } from '../domain/party-scope.js';
import { mapUserAvatar } from './mappers.js';
import type { TransactionContext } from './transaction.js';

const TABLE = 'party_access';

type Runner = Knex | Knex.Transaction;

export interface ScopeOptions {
  /** `manage` also requires the grant itself to be at `manage`. */
  level: PartyAccessLevel;
  /** `'assigned'` hides unassigned parties too — the "My parties" toggle. */
  filter?: PartyScopeFilter;
}

/**
 * Narrow a query to the parties a caller may reach.
 *
 * `partyIdColumn` is a **qualified column reference** — `'l.party_id'`,
 * `'o.party_id'`, `'parties.id'` — bound with `??` so it is an identifier, not
 * a value. Passing a caller-supplied string here would be an injection; every
 * call site passes a literal.
 *
 * The predicate is "nobody is assigned to this party **or** I am", which is why
 * both halves are needed and why the anti-join comes first: dropping it would
 * turn every unassigned party invisible and empty the product on the day this
 * shipped.
 */
export function applyPartyScope<T extends Knex.QueryBuilder>(
  builder: T,
  tenantId: string,
  partyIdColumn: string,
  scope: PartyScope,
  options: ScopeOptions,
): T {
  const { level, filter } = options;

  if (!scope.seesAll) {
    builder.where((outer) => {
      outer.whereNotExists((sub) =>
        sub
          .select(db().raw('1'))
          .from(`${TABLE} as pac_any`)
          .where('pac_any.tenant_id', tenantId)
          .whereRaw('pac_any.party_id = ??', [partyIdColumn]),
      );

      if (scope.userId) {
        outer.orWhereExists((sub) => {
          const mine = sub
            .select(db().raw('1'))
            .from(`${TABLE} as pac_mine`)
            .where('pac_mine.tenant_id', tenantId)
            .where('pac_mine.user_id', scope.userId as string)
            .whereRaw('pac_mine.party_id = ??', [partyIdColumn]);

          if (level === 'manage') mine.where('pac_mine.access_level', 'manage');
          return mine;
        });
      }
    });
  }

  // "My parties" — a listing preference, not a permission, so it is applied at
  // whatever level the caller was granted rather than re-checking `manage`.
  if (filter === 'assigned') {
    if (!scope.userId) return builder.whereRaw('false') as T;

    builder.whereExists((sub) =>
      sub
        .select(db().raw('1'))
        .from(`${TABLE} as pac_pick`)
        .where('pac_pick.tenant_id', tenantId)
        .where('pac_pick.user_id', scope.userId as string)
        .whereRaw('pac_pick.party_id = ??', [partyIdColumn]),
    );
  }

  return builder;
}

interface GrantRow {
  party_id: string;
  user_id: string;
  access_level: PartyAccessLevel;
}

/** Every grant on one party. An empty array means the party is open. */
export async function grantsForParty(
  tenantId: string,
  partyId: string,
  runner: Runner = db(),
): Promise<Array<{ userId: string; level: PartyAccessLevel }>> {
  const rows = await runner(TABLE)
    .where({ tenant_id: tenantId, party_id: partyId })
    .select<GrantRow[]>('party_id', 'user_id', 'access_level');

  return rows.map((row) => ({ userId: row.user_id, level: row.access_level }));
}

/**
 * Grants for many parties at once, keyed by party id.
 *
 * The Party Access screen renders one row per party with its assignees on it;
 * without this it would be a query per row.
 */
export async function grantsForParties(
  tenantId: string,
  partyIds: readonly string[],
): Promise<Map<string, PartyAccessAssignee[]>> {
  const byParty = new Map<string, PartyAccessAssignee[]>();
  if (partyIds.length === 0) return byParty;

  const rows = await db()(`${TABLE} as pac`)
    .join('users as u', 'u.id', 'pac.user_id')
    .leftJoin('roles as r', 'r.id', 'u.role_id')
    .where('pac.tenant_id', tenantId)
    .whereIn('pac.party_id', [...partyIds])
    .orderBy('u.display_name', 'asc')
    .select<
      Array<{
        party_id: string;
        user_id: string;
        access_level: PartyAccessLevel;
        display_name: string;
        username: string;
        role_name: string | null;
        role_tier: string | null;
        is_active: boolean;
        avatar_id: string | null;
        avatar_blurhash: string | null;
        avatar_size: number | null;
        avatar_byte_size: number | null;
        avatar_uploaded_at: Date | string | null;
      }>
    >(
      'pac.party_id',
      'pac.user_id',
      'pac.access_level',
      'u.display_name',
      'u.username',
      'u.is_active',
      'u.avatar_id',
      'u.avatar_blurhash',
      'u.avatar_size',
      'u.avatar_byte_size',
      'u.avatar_uploaded_at',
      { role_name: 'r.name' },
      { role_tier: 'r.tier' },
    );

  for (const row of rows) {
    const list = byParty.get(row.party_id) ?? [];
    list.push({
      userId: row.user_id,
      level: row.access_level,
      displayName: row.display_name,
      username: row.username,
      roleName: row.role_name ?? '',
      roleTier: (row.role_tier as PartyAccessAssignee['roleTier'] | null) ?? 'office',
      isActive: Boolean(row.is_active),
      avatar: mapUserAvatar(row),
    });
    byParty.set(row.party_id, list);
  }

  return byParty;
}

/** Party ids this person is explicitly assigned to. */
export async function assignedPartyIds(
  tenantId: string,
  userId: string,
  level?: PartyAccessLevel,
): Promise<string[]> {
  const query = db()(TABLE).where({ tenant_id: tenantId, user_id: userId });
  if (level === 'manage') query.where('access_level', 'manage');

  const rows = await query.select<Array<{ party_id: string }>>('party_id');
  return rows.map((row) => row.party_id);
}

/**
 * Replace a party's whole grant set inside the caller's transaction.
 *
 * Delete-then-insert, never a per-entry merge: a permission set is approved as
 * a whole (`docs/ROLES_AND_USERS.md` §5), and merging two administrators'
 * partial edits produces a union neither of them approved. The row lock the
 * caller takes on the party is what makes the delete and insert safe against a
 * concurrent save.
 */
export async function replaceGrants(
  tenantId: string,
  partyId: string,
  entries: readonly PartyAccessEntry[],
  grantedBy: string | null,
  trx: TransactionContext,
): Promise<void> {
  await trx(TABLE).where({ tenant_id: tenantId, party_id: partyId }).delete();
  if (entries.length === 0) return;

  await trx(TABLE).insert(
    entries.map((entry) => ({
      tenant_id: tenantId,
      party_id: partyId,
      user_id: entry.userId,
      access_level: entry.level,
      granted_by: grantedBy,
    })),
  );
}

/*
 * There is deliberately no `removeGrantsForUser`. Users are soft-deleted, and a
 * restored person must come back holding the parties they were assigned —
 * which is also why `party_access.user_id` carries no foreign key. A grant
 * naming a deleted user is inert: `levelFor` matches on the signed-in id, and
 * nobody signs in as a deleted account.
 */

/**
 * The same predicate as `applyPartyScope`, as a raw SQL fragment.
 *
 * Search, the dashboard and the reports are hand-written SQL rather than query
 * builders — they aggregate in ways Knex would only obscure — so they need the
 * rule in a form they can paste into a `WHERE`. Returning `''` for an
 * unrestricted caller keeps the call sites free of conditionals.
 *
 * `partyIdExpr` is interpolated, never bound: it is a column expression such as
 * `pa.id` or `l.party_id`, and every call site passes a literal.
 */
export function partyScopeSql(
  partyIdExpr: string,
  tenantId: string,
  scope: PartyScope,
  level: PartyAccessLevel = 'view',
): { sql: string; bindings: string[] } {
  if (scope.seesAll) return { sql: '', bindings: [] };

  const unassigned = `NOT EXISTS (SELECT 1 FROM ${TABLE} pac_any
       WHERE pac_any.tenant_id = ? AND pac_any.party_id = ${partyIdExpr})`;

  if (!scope.userId) return { sql: ` AND (${unassigned})`, bindings: [tenantId] };

  const levelClause = level === 'manage' ? ` AND pac_mine.access_level = 'manage'` : '';
  const mine = `EXISTS (SELECT 1 FROM ${TABLE} pac_mine
       WHERE pac_mine.tenant_id = ? AND pac_mine.party_id = ${partyIdExpr}
         AND pac_mine.user_id = ?${levelClause})`;

  return { sql: ` AND (${unassigned} OR ${mine})`, bindings: [tenantId, tenantId, scope.userId] };
}

/**
 * The party scope for the activity log, where the record a row refers to is
 * named indirectly by `(entity_type, entity_id)`.
 *
 * Only the three party-bound entity types are narrowed. Everything else — a
 * product edit, a role change, a sign-in — belongs to the company and stays
 * visible to anyone who holds `logs.view`.
 *
 * An entry whose subject no longer exists is hidden rather than shown. That is
 * the fail-closed direction, and the alternative would leak precisely the rows
 * this exists to hide the moment a record is purged.
 */
export function partyScopeLogSql(
  tenantId: string,
  scope: PartyScope,
): { sql: string; bindings: string[] } {
  if (scope.seesAll) return { sql: '', bindings: [] };

  const bindings: string[] = [];
  const branches: string[] = [];

  for (const [entity, table, column] of [
    ['lead', 'leads', 'scoped_log.party_id'],
    ['order', 'orders', 'scoped_log.party_id'],
    ['party', 'parties', 'scoped_log.id'],
  ] as const) {
    const narrowed = partyScopeSql(column, tenantId, scope);
    bindings.push(tenantId, ...narrowed.bindings);
    branches.push(
      `(activity_log.entity_type = '${entity}' AND EXISTS (
         SELECT 1 FROM ${table} scoped_log
          WHERE scoped_log.tenant_id = ? AND scoped_log.id = activity_log.entity_id${narrowed.sql}))`,
    );
  }

  return {
    sql: ` AND (activity_log.entity_type NOT IN ('lead', 'order', 'party') OR ${branches.join(' OR ')})`,
    bindings,
  };
}

/**
 * This person's own grants, restricted to the parties in `partyIds`.
 *
 * Sent in the Office Panel's snapshot. Note what is *not* here: an unassigned
 * party produces no row, because it is open rather than granted — everyone's
 * own role decides the rest. A screen asking "may I change this?" therefore
 * has to read the absence of a `view` grant, not the presence of a `manage`
 * one.
 */
export async function grantsForUser(
  tenantId: string,
  userId: string | null,
  partyIds: readonly string[],
): Promise<Array<{ partyId: string; level: PartyAccessLevel }>> {
  if (!userId || partyIds.length === 0) return [];

  const rows = await db()(TABLE)
    .where({ tenant_id: tenantId, user_id: userId })
    .whereIn('party_id', [...partyIds])
    .select<Array<{ party_id: string; access_level: PartyAccessLevel }>>('party_id', 'access_level');

  return rows.map((row) => ({ partyId: row.party_id, level: row.access_level }));
}
