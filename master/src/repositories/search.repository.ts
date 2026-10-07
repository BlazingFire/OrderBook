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
      // The vector already carries every variant code and label (the
      // `product_variants_search_trg` trigger refreshes it), so a code typed
      // here finds its model; the subtitle names the category and the codes.
      const { rows } = await runner.raw<{ rows: RankedRow[] }>(
        `SELECT p.id,
                p.name AS title,
                COALESCE(c.name, '')
                  || COALESCE(' · ' || (
                       SELECT string_agg(v.code, ', ' ORDER BY v.sequence, v.code)
                         FROM product_variants v
                        WHERE v.product_id = p.id AND v.is_active
                     ), '') AS subtitle,
                ts_rank(p.search_vector, ${TSQUERY}) AS rank
           FROM products p
           LEFT JOIN product_categories c ON c.id = p.category_id
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
      // The subtitle names the record by its PO number; a final order reads
      // its lead's. Either falls back to the id when there is none.
      const number =
        kind === 'lead_line'
          ? 'COALESCE(parent.po_number, li.parent_id)'
          : 'COALESCE((SELECT ld.po_number FROM leads ld WHERE ld.id = parent.lead_id), li.parent_id)';
      const numberGroup = kind === 'lead_line' ? 'parent.po_number' : 'parent.lead_id';

      const { rows } = await runner.raw<{ rows: RankedRow[] }>(
        `SELECT li.parent_id AS id,
                li.product_name AS title,
                ${number} || COALESCE(' · ' || li.code, '') || COALESCE(' · ' || li.variant_label, '') AS subtitle,
                MAX(ts_rank(li.search_vector, ${TSQUERY})) AS rank
           FROM line_items li
           JOIN ${parentTable} parent
             ON parent.id = li.parent_id AND parent.tenant_id = li.tenant_id
          WHERE li.tenant_id = ?
            AND li.parent_type = ?
            AND parent.deleted_at IS NULL
            AND li.search_vector @@ ${TSQUERY}${partyScope.sql}
          GROUP BY li.parent_id, ${numberGroup}, li.product_name, li.code, li.variant_label
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
  options: { term: string; limit: number; include: string[]; categoryId?: string },
  runner: Runner = db(),
): Promise<{ rows: Row[]; truncated: boolean }> {
  const tsQuery = prefixTsQuery(options.term);
  const hasQuery = tsQuery !== null;
  const pattern = likePrefix(options.term.trim());

  // One more than asked for, so "there are more" is a fact rather than a guess.
  const fetch = options.limit + 1;
  const hasInclude = options.include.length > 0;
  const categoryId = options.categoryId?.trim();
  if (categoryId) return pickSubProducts(tenantId, categoryId, options, fetch, runner);

  // The codes live on the variants, so the prefix boost and the prefix
  // filter both look there: typing `41` puts the model that sells `41` first.
  const CODE_PREFIX = `EXISTS (
    SELECT 1 FROM product_variants v
     WHERE v.product_id = p.id AND v.is_active AND v.code ILIKE ? ESCAPE '\\'
  )`;

  const { rows } = await runner.raw<{ rows: Row[] }>(
    `SELECT p.*, ${PICKED_CATEGORY_COLUMNS},
            (${CODE_PREFIX}
             OR COALESCE(p.name ILIKE ? ESCAPE '\\', false)) AS exact_prefix,
            CASE WHEN ? THEN ts_rank(p.search_vector, to_tsquery('simple', ?)) ELSE 0 END AS rank
       FROM products p
       LEFT JOIN product_categories c ON c.id = p.category_id
      WHERE p.tenant_id = ?
        AND (
          (p.is_active AND p.deleted_at IS NULL AND (
            NOT ?
            OR p.search_vector @@ to_tsquery('simple', ?)
            OR ${CODE_PREFIX}
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
 * The ids, of those given, that are still in the catalogue: active and not deleted.
 * The tenant guard is the same one the picker has; `pickProducts`' `include` is not used
 * for this because it hands back a named id whether or not it is live.
 */
export async function liveProductIds(
  tenantId: string,
  ids: string[],
  runner: Runner = db(),
): Promise<string[]> {
  if (ids.length === 0) return [];
  const { rows } = await runner.raw<{ rows: Array<{ id: string }> }>(
    `SELECT id FROM products
      WHERE tenant_id = ? AND id = ANY(?) AND is_active AND deleted_at IS NULL`,
    [tenantId, ids],
  );
  return rows.map((row) => String(row.id));
}

/** What `mapProduct` reads of the category, joined as `c`: brand lives only there. */
const PICKED_CATEGORY_COLUMNS =
  'c.name AS category_name, c.code AS category_code, c.brand AS category_brand';

/**
 * The sub-product bar: every live sub product of one product (category), in
 * catalogue order (`docs/catalogue/CATALOGUE_MODEL.md` §5), narrowed as
 * somebody types by the printed name anywhere in it or a code from its start.
 *
 * Not ranked like the whole-catalogue pick above. Inside one product the
 * counter reads the list the way the printed page lays it out, and a list
 * that reshuffles by relevance on every keystroke loses their place in it.
 */
async function pickSubProducts(
  tenantId: string,
  categoryId: string,
  options: { term: string; limit: number; include: string[] },
  fetch: number,
  runner: Runner,
): Promise<{ rows: Row[]; truncated: boolean }> {
  const term = options.term.trim();

  const { rows } = await runner.raw<{ rows: Row[] }>(
    `SELECT p.*, ${PICKED_CATEGORY_COLUMNS}
       FROM products p
       LEFT JOIN product_categories c ON c.id = p.category_id
      WHERE p.tenant_id = ?
        AND p.category_id = ?
        AND (
          (p.is_active AND p.deleted_at IS NULL AND (
            ? = ''
            OR p.name ILIKE ? ESCAPE '\\'
            OR EXISTS (
              SELECT 1 FROM product_variants v
               WHERE v.product_id = p.id AND v.is_active AND v.code ILIKE ? ESCAPE '\\'
            )
          ))
          OR (? AND p.id = ANY(?))
        )
      ORDER BY p.sort_order ASC NULLS LAST, lower(p.name) ASC, p.id ASC
      LIMIT ?`,
    [
      tenantId,
      categoryId,
      term,
      likeContains(term),
      likePrefix(term),
      options.include.length > 0,
      options.include,
      fetch,
    ],
  );

  return { rows: rows.slice(0, options.limit), truncated: rows.length > options.limit };
}

/**
 * Categories — the owner's Products — for the product bar
 * (`docs/catalogue/CATALOGUE_MODEL.md` §5): the code from its start, the
 * name or the brand anywhere in it. A code typed in full comes first; the
 * rest keep catalogue order rather than a relevance order, and an empty term
 * lists them all — the bar is a menu as much as a search.
 *
 * Only live categories holding a live sub product are offered (the v1.1.0
 * rule): an empty one is a dead end the counter cannot add anything from. An
 * `include`d id comes back regardless, so a chosen chip never vanishes.
 */
export async function pickCategories(
  tenantId: string,
  options: { term: string; limit: number; include: string[] },
  runner: Runner = db(),
): Promise<{ rows: Row[]; truncated: boolean }> {
  const term = options.term.trim();
  const pattern = likePrefix(term);
  const contains = likeContains(term);
  const fetch = options.limit + 1;
  const hasInclude = options.include.length > 0;

  // Nothing typed is no code at all: without the `<> ''` guard every category
  // with no code would "match" it exactly and lead the idle list.
  const { rows } = await runner.raw<{ rows: Row[] }>(
    `SELECT c.*,
            (? <> '' AND lower(coalesce(c.code, '')) = lower(?)) AS exact_code
       FROM product_categories c
      WHERE c.tenant_id = ?
        AND (
          (
            c.deleted_at IS NULL
            AND (? = ''
              OR c.code ILIKE ? ESCAPE '\\'
              OR c.name ILIKE ? ESCAPE '\\'
              OR c.brand ILIKE ? ESCAPE '\\')
            AND EXISTS (
              SELECT 1 FROM products p
               WHERE p.tenant_id = c.tenant_id
                 AND p.category_id = c.id
                 AND p.is_active
                 AND p.deleted_at IS NULL
            )
          )
          OR (? AND c.id = ANY(?))
        )
      ORDER BY exact_code DESC, c.sort_order ASC NULLS LAST, lower(c.name) ASC, c.id ASC
      LIMIT ?`,
    [term, term, tenantId, term, pattern, contains, contains, hasInclude, options.include, fetch],
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
