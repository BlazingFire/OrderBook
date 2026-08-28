/**
 * How much a managed option-list value is actually used, across the tables
 * that hold the raw string (`docs/backend-modules/04-API-CONTRACT.md` §5.2).
 *
 * One query per set, `GROUP BY` over every source table unioned together —
 * never one query per value, and never `stock_movements`. The ledger is
 * projected into the millions (`docs/schema/05`) and no index on it leads
 * with `colour`, so a colour-only probe would seq-scan it on every Fields
 * screen open. Three sources answer "is this colour in use" adequately;
 * `stock_movements` is read once, at migration time, for the initial seed —
 * a different question with a different cost.
 */

import type { FieldListKey } from '@orderbook/shared';
import type { Knex } from 'knex';

import { db } from '../db/knex.js';

type Runner = Knex | Knex.Transaction;

export interface UsageRow {
  value: string;
  source: string;
  count: number;
}

interface SourceDefinition {
  /** Label the client shows for this source — a plain string, not a translation key (§5.1). */
  source: string;
  sql: string;
}

const SOURCES: Record<FieldListKey, readonly SourceDefinition[]> = {
  'lead.sourcePlatform': [
    {
      source: 'leads',
      sql: `SELECT source_platform AS value, count(*) AS count
              FROM leads
             WHERE tenant_id = ? AND deleted_at IS NULL AND source_platform IS NOT NULL
             GROUP BY source_platform`,
    },
  ],
  'stock.colour': [
    {
      source: 'inventory_stock',
      sql: `SELECT colour AS value, count(*) AS count
              FROM inventory_stock
             WHERE tenant_id = ?
             GROUP BY colour`,
    },
    {
      source: 'line_item_quantities',
      sql: `SELECT q.colour AS value, count(*) AS count
              FROM line_item_quantities q
              JOIN line_items li ON li.id = q.line_item_id AND li.tenant_id = ?
             GROUP BY q.colour`,
    },
    {
      source: 'stock_reservations',
      sql: `SELECT colour AS value, count(*) AS count
              FROM stock_reservations
             WHERE tenant_id = ?
             GROUP BY colour`,
    },
  ],
  'product.productType': [
    {
      source: 'products',
      sql: `SELECT product_type AS value, count(*) AS count
              FROM products
             WHERE tenant_id = ? AND deleted_at IS NULL AND product_type IS NOT NULL
             GROUP BY product_type`,
    },
    {
      source: 'line_items',
      sql: `SELECT product_type AS value, count(*) AS count
              FROM line_items
             WHERE tenant_id = ? AND product_type IS NOT NULL
             GROUP BY product_type`,
    },
    {
      source: 'party_product_variants',
      sql: `SELECT product_type AS value, count(*) AS count
              FROM party_product_variants
             WHERE tenant_id = ? AND product_type IS NOT NULL
             GROUP BY product_type`,
    },
  ],
  /*
   * The four ceramic vocabularies. Each has exactly one source — the products
   * table — because unlike `product_type` these are not snapshotted onto a line
   * item: a lead's line carries the size and grade it was quoted at, not the
   * brand.
   */
  'product.brand': [
    {
      source: 'products',
      sql: `SELECT brand AS value, count(*) AS count
              FROM products
             WHERE tenant_id = ? AND deleted_at IS NULL AND brand IS NOT NULL
             GROUP BY brand`,
    },
  ],
  'product.shade': [
    {
      source: 'products',
      sql: `SELECT shade AS value, count(*) AS count
              FROM products
             WHERE tenant_id = ? AND deleted_at IS NULL AND shade IS NOT NULL
             GROUP BY shade`,
    },
  ],
  'product.surfaceTexture': [
    {
      source: 'products',
      sql: `SELECT surface_texture AS value, count(*) AS count
              FROM products
             WHERE tenant_id = ? AND deleted_at IS NULL AND surface_texture IS NOT NULL
             GROUP BY surface_texture`,
    },
  ],
  'product.originPlant': [
    {
      source: 'products',
      sql: `SELECT origin_plant AS value, count(*) AS count
              FROM products
             WHERE tenant_id = ? AND deleted_at IS NULL AND origin_plant IS NOT NULL
             GROUP BY origin_plant`,
    },
  ],
  'line.packaging': [
    {
      source: 'line_items',
      sql: `SELECT packaging AS value, count(*) AS count
              FROM line_items
             WHERE tenant_id = ? AND packaging IS NOT NULL
             GROUP BY packaging`,
    },
    {
      source: 'party_product_variants',
      sql: `SELECT packaging AS value, count(*) AS count
              FROM party_product_variants
             WHERE tenant_id = ? AND packaging IS NOT NULL
             GROUP BY packaging`,
    },
  ],
};

interface RawRow {
  value: string;
  source: string;
  count: string | number;
}

/** Every (value, source, count) row for one managed set — a single UNION ALL, one round trip. */
export async function usageForListKey(
  tenantId: string,
  listKey: FieldListKey,
  runner: Runner = db(),
): Promise<UsageRow[]> {
  const sources = SOURCES[listKey];

  const unionSql = sources
    .map((source) => `SELECT '${source.source}' AS source, u.value, u.count FROM (${source.sql}) u`)
    .join('\nUNION ALL\n');

  const bindings = sources.map(() => tenantId);

  const { rows } = await runner.raw<{ rows: RawRow[] }>(unionSql, bindings);

  return rows.map((row) => ({ value: row.value, source: row.source, count: Number(row.count) }));
}
