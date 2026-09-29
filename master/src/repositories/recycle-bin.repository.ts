/**
 * The only cross-table SQL in the Recycle Bin module: a `UNION ALL` over the
 * soft-deletable tables — **nine branches**. Six landed with the Bin itself,
 * two with Fields and one with catalogue v2. Nothing checks that `BRANCHES` still covers every
 * member of `RECYCLE_BIN_ENTITIES`: a type added there without a branch here
 * typechecks, the route accepts it, and it never shows in the Bin.
 *
 * Branches the caller may not see are omitted from the SQL entirely — that
 * is simultaneously the permission filter, the entity-type filter and the
 * optimisation: Postgres never touches a table the actor holds no delete key
 * for. `deleted_by` display names resolve in one follow-up query over the
 * page's distinct ids, not one `LEFT JOIN` per branch, so a page never pays
 * for eight joins to answer a question only some of its rows need.
 */

import type { BinCounts, RecycleBinEntityType } from '@orderbook/shared';
import type { Knex } from 'knex';

import { db } from '../db/knex.js';
import type { PartyScope } from '../domain/party-scope.js';
import { partyScopeSql } from './party-access.repository.js';
import { toRequiredIso } from './mappers.js';

type Runner = Knex | Knex.Transaction;

/**
 * Everything `BinEntry` needs except `deletedByName` and `cursor` — both
 * filled in by the service, which is the layer allowed to import
 * `domain/recycle-bin.ts`'s `encodeBinCursor` (repositories must not import
 * domain guards, `01-ARCHITECTURE.md` §3.1's file-order table).
 */
interface BinEntryRow {
  entityType: RecycleBinEntityType;
  id: string;
  label: string;
  sublabel: string | null;
  deletedAt: string;
  /** SQL-rendered microsecond text — the cursor's exact payload, never re-derived from `deletedAt`. */
  deletedAtCursorText: string;
  deletedBy: string | null;
  version: number | null;
}

interface BranchDefinition {
  entityType: RecycleBinEntityType;
  /** `label, sublabel` selected from the branch's own columns/joins. */
  sql: string;
  /**
   * The party-id expression to narrow this branch by, for the three branches
   * that hang off a party. Absent means the branch is not party-scoped — a
   * product, a role and a user belong to the company, not to a customer.
   */
  partyIdExpr?: string;
}

/**
 * `deleted_at_text` is the SQL-rendered microsecond text the cursor stores;
 * `deleted_at` (plain, TIMESTAMPTZ) is what the outer query's keyset WHERE
 * compares against — never re-derived from the text, and never passed
 * through a JS `Date`.
 */
const CURSOR_TEXT = `to_char(deleted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const BRANCHES: BranchDefinition[] = [
  {
    entityType: 'lead',
    sql: `SELECT 'lead' AS entity_type, l.id AS id, pa.name AS label, l.id AS sublabel,
                 l.deleted_at AS deleted_at, ${CURSOR_TEXT.replace(/deleted_at/g, 'l.deleted_at')} AS deleted_at_text,
                 l.deleted_by AS deleted_by, l.version AS version
            FROM leads l JOIN parties pa ON pa.id = l.party_id
           WHERE l.tenant_id = ? AND l.deleted_at IS NOT NULL`,
    partyIdExpr: 'l.party_id',
  },
  {
    entityType: 'order',
    sql: `SELECT 'order' AS entity_type, o.id AS id, pa.name AS label, o.id AS sublabel,
                 o.deleted_at AS deleted_at, ${CURSOR_TEXT.replace(/deleted_at/g, 'o.deleted_at')} AS deleted_at_text,
                 o.deleted_by AS deleted_by, o.version AS version
            FROM orders o JOIN parties pa ON pa.id = o.party_id
           WHERE o.tenant_id = ? AND o.deleted_at IS NOT NULL`,
    partyIdExpr: 'o.party_id',
  },
  {
    entityType: 'party',
    sql: `SELECT 'party' AS entity_type, id, name AS label, party_code AS sublabel,
                 deleted_at, ${CURSOR_TEXT} AS deleted_at_text, deleted_by, version
            FROM parties
           WHERE tenant_id = ? AND deleted_at IS NOT NULL`,
    partyIdExpr: 'parties.id',
  },
  {
    entityType: 'product',
    sql: `SELECT 'product' AS entity_type, id, name AS label,
                 (SELECT string_agg(v.code, ', ' ORDER BY v.sequence, v.code)
                    FROM product_variants v WHERE v.product_id = products.id) AS sublabel,
                 deleted_at, ${CURSOR_TEXT} AS deleted_at_text, deleted_by, version
            FROM products
           WHERE tenant_id = ? AND deleted_at IS NOT NULL`,
  },
  {
    entityType: 'role',
    sql: `SELECT 'role' AS entity_type, id, name AS label, tier AS sublabel,
                 deleted_at, ${CURSOR_TEXT} AS deleted_at_text, deleted_by, NULL::integer AS version
            FROM roles
           WHERE tenant_id = ? AND deleted_at IS NOT NULL`,
  },
  {
    entityType: 'user',
    sql: `SELECT 'user' AS entity_type, id, display_name AS label, username AS sublabel,
                 deleted_at, ${CURSOR_TEXT} AS deleted_at_text, deleted_by, NULL::integer AS version
            FROM users
           WHERE tenant_id = ? AND deleted_at IS NOT NULL`,
  },
  // These branches sit on UUID primary keys while every branch above is on a
  // TEXT record id, and Postgres refuses a UNION that mixes `uuid` with
  // `text` outright — hence the explicit `::text`. `BinEntry.id` is a string
  // on the wire either way, so nothing downstream can tell the difference.
  //
  // Stage 3 (Fields). Both were added to `RECYCLE_BIN_ENTITIES` and to
  // `RESTORE_PERMISSION` when Fields landed, but neither got a branch here —
  // so a deleted option value or custom field was listed nowhere and could
  // not be restored through the Bin at all, while every type check said it
  // should be. `FLD-19b` in `fields.integration.test.ts` now makes that
  // divergence impossible to reintroduce.
  {
    entityType: 'option_list_item',
    sql: `SELECT 'option_list_item' AS entity_type, id::text AS id, label AS label, list_key AS sublabel,
                 deleted_at, ${CURSOR_TEXT} AS deleted_at_text, deleted_by, version
            FROM option_lists
           WHERE tenant_id = ? AND deleted_at IS NOT NULL`,
  },
  {
    entityType: 'custom_field_definition',
    sql: `SELECT 'custom_field_definition' AS entity_type, id::text AS id, label AS label, entity AS sublabel,
                 deleted_at, ${CURSOR_TEXT} AS deleted_at_text, deleted_by, version
            FROM custom_field_definitions
           WHERE tenant_id = ? AND deleted_at IS NOT NULL`,
  },
  // Catalogue v2 (`20260326`). `product_categories` records no `deleted_by`
  // and no version, so a category row is attributed to nobody: it shows to
  // `recycleBin.viewAll` holders only, like an unattended panel's deletion.
  {
    entityType: 'product_category',
    sql: `SELECT 'product_category' AS entity_type, id, name AS label, code AS sublabel,
                 deleted_at, ${CURSOR_TEXT} AS deleted_at_text, NULL::text AS deleted_by, NULL::integer AS version
            FROM product_categories
           WHERE tenant_id = ? AND deleted_at IS NOT NULL`,
  },
];

interface BinRow {
  entity_type: RecycleBinEntityType;
  id: string;
  label: string;
  sublabel: string | null;
  deleted_at: Date;
  deleted_at_text: string;
  deleted_by: string | null;
  version: number | null;
}

export interface ListBinOptions {
  types: readonly RecycleBinEntityType[];
  search?: string;
  deletedBy?: string;
  scope: PartyScope;
  /** From `decodeBinCursor` — the last row of the previous page. */
  after?: { deletedAt: string; entityType: RecycleBinEntityType; id: string };
  limit: number;
}

export interface BinListResult {
  entries: BinEntryRow[];
  /** True when more rows exist past `limit` — the n+1 probe, never a COUNT. */
  hasMore: boolean;
}

/**
 * The party scope is applied **per branch**, not to the union's outer WHERE:
 * only three of the nine branches have a party at all, and the union's columns
 * do not carry one. Each branch's own alias is what the predicate can name.
 */
function buildUnion(
  types: readonly RecycleBinEntityType[],
  tenantId: string,
  scope: PartyScope,
): { sql: string; bindings: Array<string | number> } {
  const chosen = BRANCHES.filter((branch) => types.includes(branch.entityType));
  const bindings: Array<string | number> = [];
  const parts = chosen.map((branch) => {
    bindings.push(tenantId);
    if (!branch.partyIdExpr) return branch.sql;

    const narrowed = partyScopeSql(branch.partyIdExpr, tenantId, scope);
    bindings.push(...narrowed.bindings);
    return branch.sql + narrowed.sql;
  });
  return { sql: parts.join('\nUNION ALL\n'), bindings };
}

export async function listBinEntries(
  tenantId: string,
  options: ListBinOptions,
  runner: Runner = db(),
): Promise<BinListResult> {
  if (options.types.length === 0) return { entries: [], hasMore: false };

  const { sql: unionSql, bindings } = buildUnion(options.types, tenantId, options.scope);

  let where = '';
  if (options.deletedBy) {
    where += ' AND u.deleted_by = ?';
    bindings.push(options.deletedBy);
  }
  if (options.search) {
    where += ' AND u.label ILIKE ?';
    bindings.push(`%${options.search}%`);
  }
  if (options.after) {
    where += ' AND (u.deleted_at, u.entity_type, u.id) < (?::timestamptz, ?, ?)';
    bindings.push(options.after.deletedAt, options.after.entityType, options.after.id);
  }

  const fetch = options.limit + 1;
  bindings.push(fetch);

  const { rows } = await runner.raw<{ rows: BinRow[] }>(
    `SELECT * FROM (\n${unionSql}\n) u
      WHERE true${where}
      ORDER BY u.deleted_at DESC, u.entity_type DESC, u.id DESC
      LIMIT ?`,
    bindings,
  );

  const hasMore = rows.length > options.limit;
  const page = hasMore ? rows.slice(0, options.limit) : rows;

  return {
    entries: page.map((row) => toBinEntry(row)),
    hasMore,
  };
}

function toBinEntry(row: BinRow): BinEntryRow {
  return {
    entityType: row.entity_type,
    id: row.id,
    label: row.label,
    sublabel: row.sublabel,
    deletedAt: toRequiredIso(row.deleted_at),
    deletedAtCursorText: row.deleted_at_text,
    deletedBy: row.deleted_by,
    version: row.version,
  };
}

/** One query per branch, summed — cheaper than the UNION ALL for a fixed-size count object. */
export async function binCounts(
  tenantId: string,
  types: readonly RecycleBinEntityType[],
  deletedBy: string | undefined,
  scope: PartyScope,
  runner: Runner = db(),
): Promise<BinCounts> {
  const chosen = BRANCHES.filter((branch) => types.includes(branch.entityType));
  if (chosen.length === 0) return {};

  const { sql: unionSql, bindings } = buildUnion(
    chosen.map((b) => b.entityType),
    tenantId,
    scope,
  );

  let where = '';
  if (deletedBy) {
    where += ' AND u.deleted_by = ?';
    bindings.push(deletedBy);
  }

  const { rows } = await runner.raw<{ rows: Array<{ entity_type: RecycleBinEntityType; count: string }> }>(
    `SELECT u.entity_type, count(*) AS count FROM (\n${unionSql}\n) u WHERE true${where} GROUP BY u.entity_type`,
    bindings,
  );

  const counts: BinCounts = {};
  for (const row of rows) counts[row.entity_type] = Number(row.count);
  return counts;
}

/** Display names for a page's distinct `deleted_by` ids — one query, never one join per branch. */
/**
 * Everybody who has deleted something still in the Bin.
 *
 * A facet, deliberately, rather than the set of names on the page in front of
 * you. The screen used to build its "deleted by" options from whatever pages it
 * had already fetched, so the filter could only ever offer the people whose
 * deletions you had already scrolled past — and choosing one then re-queried
 * from the top, which is the opposite of what a filter is for.
 *
 * Scoped exactly like the list it filters: same entity types, same party scope.
 * Otherwise the dropdown would name people whose deletions the caller cannot
 * see, which is a small disclosure with no upside.
 */
export async function distinctDeleters(
  tenantId: string,
  options: { types: RecycleBinEntityType[]; scope: PartyScope },
  runner: Runner = db(),
): Promise<string[]> {
  if (options.types.length === 0) return [];

  const { sql: unionSql, bindings } = buildUnion(options.types, tenantId, options.scope);

  const { rows } = await runner.raw<{ rows: Array<{ deleted_by: string }> }>(
    `SELECT DISTINCT u.deleted_by FROM (
${unionSql}
) u WHERE u.deleted_by IS NOT NULL`,
    bindings,
  );

  return rows.map((row) => row.deleted_by);
}

export async function deletedByNames(
  tenantId: string,
  userIds: readonly string[],
  runner: Runner = db(),
): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();

  const rows = await runner('users')
    .where({ tenant_id: tenantId })
    .whereIn('id', [...new Set(userIds)])
    .select<Array<{ id: string; display_name: string }>>('id', 'display_name');

  return new Map(rows.map((row) => [row.id, row.display_name]));
}

/**
 * Used only to name a still-deleted parent in a restore's `blockedBy` — never
 * for a normal read path, so it lives here rather than duplicating a
 * `findXById({ includeDeleted: true })` already declared on each entity's
 * own repository. Kept for the entity types that can appear as a Bin parent.
 */
export async function findParentStatus(
  tenantId: string,
  entityType: 'party' | 'lead' | 'role',
  id: string,
  runner: Runner = db(),
): Promise<{ label: string; isLive: boolean } | null> {
  const table = entityType === 'party' ? 'parties' : entityType === 'lead' ? 'leads' : 'roles';

  const row = await runner(table)
    .where({ tenant_id: tenantId, id })
    .select<{ label: string; deleted_at: Date | null }[]>('name as label', 'deleted_at')
    .first();

  if (!row) return null;
  return { label: row.label, isLive: row.deleted_at === null };
}
