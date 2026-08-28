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
import { partyScopeSql } from './party-access.repository.js';

type Runner = Knex | Knex.Transaction;

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
