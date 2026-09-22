/**
 * The line's grade, restored.
 *
 * `20260324000000_product_master_trim` dropped `grade` from `products`,
 * `party_product_variants` **and** `line_items` on 2026-09-21. A day later the
 * owner asked for Grade back on the lead's product card, so this puts back the
 * *line's* column and nothing else: a grade is what one line was sold as, not
 * a property of the article. Two lines of the same variant may carry different
 * grades, which is precisely why the catalogue columns stay dropped.
 *
 * Nothing is seeded. The values live in the `line.grade` option list, which
 * the trim deleted and Settings → Fields is where a company puts its own back
 * (`shared/src/domain/fields.ts`). An empty list is the correct starting
 * point, the same way `line.packaging` ships empty — a grade ladder is a
 * company's, not ours to guess.
 *
 * The search vector is deliberately left alone. `line_items_search_refresh`,
 * as the trim redefined it, names the columns it reads; re-adding a term for
 * grade would mean rewriting that function and touching every row to reindex,
 * for a word nobody searches lines by. The column is read and written, not
 * searched.
 *
 * Runs **after** the trim (see the registry's ordering note): on a fresh
 * database the trim's drop would otherwise take this column straight back out.
 * Idempotent through `IF NOT EXISTS`; `down()` drops what `up()` added, which
 * is safe here because the column is new rather than restored data.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE line_items ADD COLUMN IF NOT EXISTS grade TEXT;`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE line_items DROP COLUMN IF EXISTS grade;`);
}
