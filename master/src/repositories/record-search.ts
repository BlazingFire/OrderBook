/**
 * The list-search clause shared by the lead and order lists.
 *
 * Mirrors `matchesRecordSearch` (shared/src/domain/record-search.ts), which the
 * Office applies to its own snapshot: the term is split into words, every word
 * must appear somewhere, and "somewhere" is the record's own columns or any of
 * its line items. Still one query, so no extra round trip per list.
 */

import type { Knex } from 'knex';

const LINE_COLUMNS = [
  'product_name',
  'category_name',
  'brand_name',
  'code',
  'variant_label',
  'colour',
  'packaging',
  'grade',
] as const;

/** A literal word as an ILIKE pattern: `%` and `_` in what was typed are not wildcards. */
function likePattern(word: string): string {
  return `%${word.replace(/[\\%_]/g, '\\$&')}%`;
}

export function applyRecordSearch(
  base: Knex.QueryBuilder,
  search: string | undefined,
  options: { alias: string; parentType: 'lead' | 'order'; columns: string[] },
): void {
  const words = (search ?? '').split(/\s+/).filter(Boolean);
  const { alias, parentType, columns } = options;

  for (const word of words) {
    const pattern = likePattern(word);
    base.andWhere((builder) => {
      for (const column of columns) builder.orWhereILike(column, pattern);
      builder.orWhereExists(function () {
        this.select(1)
          .from('line_items as li')
          .whereRaw('li.tenant_id = ??', [`${alias}.tenant_id`])
          .andWhere('li.parent_type', parentType)
          .whereRaw('li.parent_id = ??', [`${alias}.id`])
          .andWhere((line) => {
            for (const column of LINE_COLUMNS) line.orWhereILike(`li.${column}`, pattern);
          });
      });
    });
  }
}
