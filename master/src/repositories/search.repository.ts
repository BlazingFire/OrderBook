/**
 * Universal search (docs/LEAD_GENERATION_FLOW.md §9).
 *
 * The supplied guide specifies SQLite FTS5. This runs on PostgreSQL, so the
 * mechanism is `tsvector` + GIN — but every rule the guide gives is kept:
 *
 *  · One index per entity, never a merged one, so a hit knows what it matched.
 *  · Line items are indexed **separately from products**, over the snapshot
 *    text. Searching a product name that has since been changed still finds the
 *    historical leads and orders quoted under the old name — which a join to
 *    the live catalogue could never do.
 *  · `tenant_id` is filtered in the WHERE clause and carried in the composite
 *    GIN index, never left to ranking.
 *  · This module only reads. The vectors are maintained by triggers on the base
 *    tables, so no code path can write data without updating the index.
 *
 * Field-level permission masking happens in the service above, not here — a
 * repository that had already stripped `rate` could not serve the caller who
 * is allowed to see it.
 */

import type { SearchHit, SearchHitKind } from '@orderbook/shared';
import type { Knex } from 'knex';

import { db } from '../db/knex.js';
import type { PartyScope } from '../domain/party-scope.js';
import { likeContains, likePrefix, prefixTsQuery } from '../domain/search-terms.js';
import { partyScopeSql } from './party-access.repository.js';

type Runner = Knex | Knex.Transaction;

/** A raw row, mapped by the service that knows which entity it is. */
type Row = Record<string, unknown>;

interface RankedRow {
  id: string;
  title: string;
  subtitle: string | null;
  rank: number;
}

/**
 * `websearch_to_tsquery` rather than `plainto_tsquery`: it understands quoted
 * phrases and `or`, and — more importantly — never throws on the punctuation
 * people actually type into a search box.
 */
const TSQUERY = `websearch_to_tsquery('simple', ?)`;

export async function search(
  tenantId: string,
  options: { term: string; kinds?: SearchHitKind[]; limit: number; scope: PartyScope },
  runner: Runner = db(),
): Promise<SearchHit[]> {
  const term = options.term.trim();
  if (!term) return [];

  const kinds = options.kinds?.length
    ? options.kinds
    : (['product', 'party', 'lead_line', 'order_line'] as SearchHitKind[]);

  const groups = await Promise.all(
    kinds.map(async (kind) => {
      const rows = await runQuery(kind, tenantId, term, options.limit, options.scope, runner);
      return rows.map((row) => ({
        kind,
        id: row.id,
        title: row.title,
        subtitle: row.subtitle,
        rank: Number(row.rank),
      }));
    }),
  );

  return groups
    .flat()
    .sort((a, b) => b.rank - a.rank)
    .slice(0, options.limit);
}

async function runQuery(
  kind: SearchHitKind,
  tenantId: string,
  term: string,
  limit: number,
  scope: PartyScope,
  runner: Runner,
): Promise<RankedRow[]> {
  switch (kind) {
    case 'product': {
      const { rows } = await runner.raw<{ rows: RankedRow[] }>(
        `SELECT p.id,
                p.name AS title,
                COALESCE(p.product_code, '') || COALESCE(' · ' || p.size, '') AS subtitle,
                ts_rank(p.search_vector, ${TSQUERY}) AS rank
           FROM products p
          WHERE p.tenant_id = ?
            AND p.is_active
            AND p.deleted_at IS NULL
            AND p.search_vector @@ ${TSQUERY}
          ORDER BY rank DESC
          LIMIT ?`,
        [term, tenantId, term, limit],
      );
      return rows;
    }

    case 'party': {
      const partyScope = partyScopeSql('pa.id', tenantId, scope);
      const { rows } = await runner.raw<{ rows: RankedRow[] }>(
        `SELECT pa.id,
                pa.name AS title,
                COALESCE(pa.party_code, '') || COALESCE(' · ' || pa.phone, '') AS subtitle,
                ts_rank(pa.search_vector, ${TSQUERY}) AS rank
           FROM parties pa
          WHERE pa.tenant_id = ?
            AND pa.is_active
            AND pa.deleted_at IS NULL
            AND pa.search_vector @@ ${TSQUERY}${partyScope.sql}
          ORDER BY rank DESC
          LIMIT ?`,
        [term, tenantId, term, ...partyScope.bindings, limit],
      );
      return rows;
    }

    case 'lead_line':
    case 'order_line': {
      const parentType = kind === 'lead_line' ? 'lead' : 'order';

      // Returns the *parent* id, not the line's: a search result has to open
      // the lead or order the line belongs to, which is what parent_type and
      // parent_id exist for.
      // The party lives on the parent record, not on the line, so the parent is
      // joined purely to give the party scope a column to test. Without it a
      // line-item search would name every lead and order in the company.
      const parentTable = kind === 'lead_line' ? 'leads' : 'orders';
      const partyScope = partyScopeSql('parent.party_id', tenantId, scope);

      const { rows } = await runner.raw<{ rows: RankedRow[] }>(
        `SELECT li.parent_id AS id,
                li.product_name AS title,
                li.parent_id || COALESCE(' · ' || li.code, '') AS subtitle,
                MAX(ts_rank(li.search_vector, ${TSQUERY})) AS rank
           FROM line_items li
           JOIN ${parentTable} parent
             ON parent.id = li.parent_id AND parent.tenant_id = li.tenant_id
          WHERE li.tenant_id = ?
            AND li.parent_type = ?
            AND parent.deleted_at IS NULL
            AND li.search_vector @@ ${TSQUERY}${partyScope.sql}
          GROUP BY li.parent_id, li.product_name, li.code
          ORDER BY rank DESC
          LIMIT ?`,
        [term, tenantId, parentType, term, ...partyScope.bindings, limit],
      );
      return rows;
    }

    default:
      return [];
  }
}

// --- The picker -------------------------------------------------------------

/**
 * Rows for a searchable dropdown, ranked for prefix typing.
 *
 * Different from `search()` above in three ways that all come from the same
 * fact — a picker answers on the third keystroke while somebody is still
 * typing:
 *
 *  · **Prefix matching.** `websearch_to_tsquery` matches whole lexemes, so
 *    "gla" finds nothing until the "zed" arrives. `prefixTsQuery` builds
 *    `gla:*` instead.
 *  · **A boost for a true prefix on the code or the name**, so typing a product
 *    code puts that product first rather than somewhere in a rank-ordered pile.
 *  · **`include`**, which is what stops the currently-selected row vanishing
 *    when somebody types a term it does not match.
 *
 * `include` sits **outside** the active and deleted guards and **inside** the
 * tenant and party guards. Outside, because a selection that was made before a
 * product was archived must still render rather than silently becoming blank;
 * inside, because neither of those is a display concern.
 *
 * The prefix `ILIKE` is a **filter as well as a boost**, and that is not
 * belt-and-braces. Postgres's parser reads `RST-300` as the three lexemes
 * `rst-300`, `rst` and `-300` — note the sign — so a `300:*` prefix built from
 * the same string matches nothing, and typing a product code in full would find
 * the product it names. Whichever way the parser split it, a row whose code or
 * name *starts with what was typed* is a match.
 */
export async function pickProducts(
  tenantId: string,
  options: { term: string; limit: number; include: string[] },
  runner: Runner = db(),
): Promise<{ rows: Row[]; truncated: boolean }> {
  const tsQuery = prefixTsQuery(options.term);
  const hasQuery = tsQuery !== null;
  const pattern = likePrefix(options.term.trim());

  // One more than asked for, so "there are more" is a fact rather than a guess.
  const fetch = options.limit + 1;
  const hasInclude = options.include.length > 0;

  const { rows } = await runner.raw<{ rows: Row[] }>(
    `SELECT p.*, c.name AS category_name,
            (COALESCE(p.product_code ILIKE ? ESCAPE '\\', false)
             OR COALESCE(p.name ILIKE ? ESCAPE '\\', false)) AS exact_prefix,
            CASE WHEN ? THEN ts_rank(p.search_vector, to_tsquery('simple', ?)) ELSE 0 END AS rank
       FROM products p
       LEFT JOIN product_categories c ON c.id = p.category_id
      WHERE p.tenant_id = ?
        AND (
          (p.is_active AND p.deleted_at IS NULL AND (
            NOT ?
            OR p.search_vector @@ to_tsquery('simple', ?)
            OR p.product_code ILIKE ? ESCAPE '\\'
            OR p.name ILIKE ? ESCAPE '\\'
          ))
          OR (? AND p.id = ANY(?))
        )
      ORDER BY exact_prefix DESC NULLS LAST, rank DESC, p.name ASC
      LIMIT ?`,
    [
      pattern,
      pattern,
      hasQuery,
      tsQuery ?? '',
      tenantId,
      hasQuery,
      tsQuery ?? '',
      pattern,
      pattern,
      hasInclude,
      options.include,
      fetch,
    ],
  );

  return { rows: rows.slice(0, options.limit), truncated: rows.length > options.limit };
}

/**
 * One row per product-colour pair, for the new-lead screen's code box.
 *
 * Deliberately not `pickProducts` with a colour join: the ranking is different.
 * A person typing here has a variant code in their hand most of the time, so an
 * exact code match outranks everything, then a code prefix, then the product's
 * own text. Reservations are not joined — free-to-sell is worked out by the
 * service from the same totals every other stock read uses, so the two can
 * never disagree.
 */
export async function pickVariants(
  tenantId: string,
  options: { term: string; limit: number },
  runner: Runner = db(),
): Promise<{ rows: Row[]; truncated: boolean }> {
  const term = options.term.trim();
  const pattern = likePrefix(term);
  const contains = likeContains(term);
  const fetch = options.limit + 1;

  const { rows } = await runner.raw<{ rows: Row[] }>(
    `SELECT s.product_id, s.colour, s.variant_code, s.quantity_boxes,
            s.reorder_level, s.min_stock_level, s.max_stock_level, s.updated_at,
            p.product_code, p.name AS product_name, p.alias, p.sin, p.size,
            p.grade, p.product_type, p.weight_kg, p.rate, p.box_coverage_sqft,
            c.name AS category_name,
            (LOWER(COALESCE(s.variant_code, '')) = LOWER(?)) AS exact_code,
            COALESCE(s.variant_code ILIKE ? ESCAPE '\\', false) AS code_prefix
       FROM inventory_stock s
       JOIN products p ON p.id = s.product_id
       LEFT JOIN product_categories c ON c.id = p.category_id
      WHERE s.tenant_id = ?
        AND p.is_active
        AND p.deleted_at IS NULL
        AND (
          ? = ''
          OR s.variant_code ILIKE ? ESCAPE '\\'
          OR p.product_code ILIKE ? ESCAPE '\\'
          OR p.name ILIKE ? ESCAPE '\\'
          OR p.sin ILIKE ? ESCAPE '\\'
          OR s.colour ILIKE ? ESCAPE '\\'
        )
      ORDER BY exact_code DESC, code_prefix DESC, p.name ASC, s.colour ASC
      LIMIT ?`,
    [term, pattern, tenantId, term, pattern, pattern, contains, pattern, contains, fetch],
  );

  return { rows: rows.slice(0, options.limit), truncated: rows.length > options.limit };
}

export async function pickParties(
  tenantId: string,
  options: { term: string; limit: number; include: string[]; scope: PartyScope },
  runner: Runner = db(),
): Promise<{ rows: Row[]; truncated: boolean }> {
  const tsQuery = prefixTsQuery(options.term);
  const hasQuery = tsQuery !== null;
  const pattern = likePrefix(options.term.trim());
  const fetch = options.limit + 1;
  const hasInclude = options.include.length > 0;

  // The party scope wraps everything, `include` included: a selection is not a
  // reason to hand somebody a party they may not see.
  const scope = partyScopeSql('pa.id', tenantId, options.scope);

  const { rows } = await runner.raw<{ rows: Row[] }>(
    `SELECT pa.*,
            (COALESCE(pa.party_code ILIKE ? ESCAPE '\\', false)
             OR COALESCE(pa.name ILIKE ? ESCAPE '\\', false)) AS exact_prefix,
            CASE WHEN ? THEN ts_rank(pa.search_vector, to_tsquery('simple', ?)) ELSE 0 END AS rank
       FROM parties pa
      WHERE pa.tenant_id = ?
        AND (
          (pa.is_active AND pa.deleted_at IS NULL AND (
            NOT ?
            OR pa.search_vector @@ to_tsquery('simple', ?)
            OR pa.party_code ILIKE ? ESCAPE '\\'
            OR pa.name ILIKE ? ESCAPE '\\'
          ))
          OR (? AND pa.id = ANY(?))
        )${scope.sql}
      ORDER BY exact_prefix DESC NULLS LAST, rank DESC, pa.name ASC
      LIMIT ?`,
    [
      pattern,
      pattern,
      hasQuery,
      tsQuery ?? '',
      tenantId,
      hasQuery,
      tsQuery ?? '',
      pattern,
      pattern,
      hasInclude,
      options.include,
      ...scope.bindings,
      fetch,
    ],
  );

  return { rows: rows.slice(0, options.limit), truncated: rows.length > options.limit };
}
