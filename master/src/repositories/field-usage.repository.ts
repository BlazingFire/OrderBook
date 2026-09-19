/**
 * How much a managed option-list value is actually used, across the tables
 * that hold the raw string (`docs/backend-modules/04-API-CONTRACT.md` §5.2).
 *
 * One query per set, `GROUP BY` over every source table unioned together —
 * never one query per value, and never the stock ledger. `stock.colour` is
 * the variant palette: a colour is "in use" when a product variant carries
 * it as its label, or a lead or order line froze it as `variant_label`.
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
      source: 'product_variants',
      sql: `SELECT label AS value, count(*) AS count
              FROM product_variants
             WHERE tenant_id = ? AND label IS NOT NULL AND deleted_at IS NULL
             GROUP BY label`,
    },
    {
      source: 'line_items',
      sql: `SELECT variant_label AS value, count(*) AS count
              FROM line_items
             WHERE tenant_id = ? AND variant_label IS NOT NULL
             GROUP BY variant_label`,
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
  'line.grade': [
    {
      source: 'line_items',
      sql: `SELECT grade AS value, count(*) AS count
              FROM line_items
             WHERE tenant_id = ? AND grade IS NOT NULL
             GROUP BY grade`,
    },
    // `products` and `party_product_variants` both carry a grade a line copies
    // from, so a grade in use on the catalogue is in use even before it reaches
    // a lead — deleting it out from under them is the case this count exists to
    // stop.
    {
      source: 'products',
      sql: `SELECT grade AS value, count(*) AS count
              FROM products
             WHERE tenant_id = ? AND grade IS NOT NULL
             GROUP BY grade`,
    },
    {
      source: 'party_product_variants',
      sql: `SELECT grade AS value, count(*) AS count
              FROM party_product_variants
             WHERE tenant_id = ? AND grade IS NOT NULL
             GROUP BY grade`,
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
