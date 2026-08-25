/**
 * The Fields "In use by" counts (`docs/backend-modules/04-API-CONTRACT.md`
 * §5.2). One query per SET (a `UNION ALL` of grouped subqueries), never one
 * query per value, so a 40-value colour list costs one round trip.
 *
 * `REFERENCING_COLUMNS` is the one hand-written map in the module — it
 * cannot be derived from `information_schema` the way a foreign key can,
 * because these sets are referenced by matching string value, with no
 * foreign key at all. `products.color` is the US spelling, the one column a
 * grep for `colour` misses entirely.
 *
 * The colour set deliberately excludes `stock_movements`: it is the
 * append-only ledger, projected into the millions, and no index leads with
 * `colour` on it (`idx_inventory_product_colour` is
 * `(tenant_id, product_id, colour)`, the wrong leading column for a
 * colour-only probe). The three other sources answer "is this colour in
 * use" adequately.
 */

import type { FieldListKey, FieldUsage, FieldUsageBreakdown } from '@orderbook/shared';
import type { Knex } from 'knex';

import { db } from '../db/knex.js';
import * as customFieldRepo from './custom-field.repository.js';

type Runner = Knex | Knex.Transaction;

interface SourceDefinition {
  /** A token the client labels — never the raw table name. */
  source: string;
  /** `value, count` — must select exactly these two columns, tenant-filtered. */
  sql: string;
}

const REFERENCING_COLUMNS: Record<FieldListKey, SourceDefinition[]> = {
  'lead.sourcePlatform': [
    {
      source: 'lead',
      sql: `SELECT source_platform AS value, count(*) AS n FROM leads
             WHERE tenant_id = ? AND source_platform IS NOT NULL AND deleted_at IS NULL
             GROUP BY source_platform`,
    },
  ],
  'stock.colour': [
    {
      source: 'lineItem',
      sql: `SELECT q.colour AS value, count(*) AS n FROM line_item_quantities q
              JOIN line_items li ON li.id = q.line_item_id
             WHERE li.tenant_id = ?
             GROUP BY q.colour`,
    },
    {
      source: 'inventory',
      sql: `SELECT colour AS value, count(*) AS n FROM inventory_stock
             WHERE tenant_id = ?
             GROUP BY colour`,
    },
    {
      source: 'stockReservation',
      sql: `SELECT colour AS value, count(*) AS n FROM stock_reservations
             WHERE tenant_id = ? AND status = 'active'
             GROUP BY colour`,
    },
  ],
  'product.productType': [
    {
      source: 'product',
      sql: `SELECT product_type AS value, count(*) AS n FROM products
             WHERE tenant_id = ? AND product_type IS NOT NULL AND deleted_at IS NULL
             GROUP BY product_type`,
    },
    {
      source: 'lineItem',
      sql: `SELECT product_type AS value, count(*) AS n FROM line_items
             WHERE tenant_id = ? AND product_type IS NOT NULL
             GROUP BY product_type`,
    },
    {
      source: 'partyProductVariant',
      sql: `SELECT product_type AS value, count(*) AS n FROM party_product_variants
             WHERE tenant_id = ? AND product_type IS NOT NULL
             GROUP BY product_type`,
    },
  ],
  'line.packaging': [
    {
      source: 'lineItem',
      sql: `SELECT packaging AS value, count(*) AS n FROM line_items
             WHERE tenant_id = ? AND packaging IS NOT NULL
             GROUP BY packaging`,
    },
    {
      source: 'partyProductVariant',
      sql: `SELECT packaging AS value, count(*) AS n FROM party_product_variants
             WHERE tenant_id = ? AND packaging IS NOT NULL
             GROUP BY packaging`,
    },
  ],
};

interface UsageRow {
  source: string;
  value: string;
  n: string;
}

export async function usageForListKey(
  tenantId: string,
  listKey: FieldListKey,
  runner: Runner = db(),
): Promise<FieldUsageBreakdown> {
  const sources = REFERENCING_COLUMNS[listKey];

  const unionSql = sources.map((s) => `SELECT '${s.source}' AS source, value, n FROM (${s.sql}) x`).join('\nUNION ALL\n');
  const bindings = sources.map(() => tenantId);

  const { rows } = await runner.raw<{ rows: UsageRow[] }>(unionSql, bindings);

  const byValue = new Map<string, FieldUsage>();
  for (const row of rows) {
    const existing = byValue.get(row.value);
    const count = Number(row.n);
    if (existing) {
      existing.total += count;
      existing.bySource[row.source] = (existing.bySource[row.source] ?? 0) + count;
    } else {
      byValue.set(row.value, { value: row.value, total: count, bySource: { [row.source]: count } });
    }
  }

  const listed = await customFieldRepo.optionValuesForKey(tenantId, listKey, { includeDeleted: false }, runner);
  const listedValues = new Set(listed.map((item) => item.value));

  const values: FieldUsage[] = [];
  const unlisted: FieldUsage[] = [];
  for (const usage of byValue.values()) {
    (listedValues.has(usage.value) ? values : unlisted).push(usage);
  }

  return {
    listKey,
    sources: sources.map((s) => s.source),
    values,
    unlisted,
  };
}
