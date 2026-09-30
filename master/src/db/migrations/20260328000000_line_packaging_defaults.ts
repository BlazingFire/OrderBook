/**
 * Box, Grass and Paper on every company's packaging list (owner's instruction,
 * 2026-09-30): the choices the New lead card's packaging box, beside each
 * quantity, offers.
 *
 * `line.packaging` shipped empty until now, on the view that a shop's
 * packaging is its own. The owner named the three this company packs in, so
 * they are seeded the way `lead.sourcePlatform` was — as `option_lists` rows,
 * which Settings → Fields can rename, reorder, retire or add to.
 *
 * A value the company already has is left alone rather than doubled, in any
 * case and in any state: a live row, a retired one, or one somebody deleted on
 * purpose (a deleted Grass stays deleted). The new rows go after whatever the
 * list already holds.
 *
 * Additive only (`migration-data-safety.test.ts`): it inserts and never
 * touches an existing row. Pinned last in the registry, behind
 * `20260327000000_option_lists_repair`, so the table it writes has its final
 * shape on every database.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  const tenants = await knex('tenants').select<Array<{ id: string }>>('id');

  for (const tenant of tenants) {
    await knex.raw(
      `
      INSERT INTO option_lists (id, tenant_id, list_key, value, label, sequence, is_active)
      SELECT gen_random_uuid(), ?, 'line.packaging', d.value, d.value,
             COALESCE(
               (SELECT max(sequence) FROM option_lists
                 WHERE tenant_id = ? AND list_key = 'line.packaging'),
               0
             ) + d.ord,
             true
        FROM (VALUES ('Box', 1), ('Grass', 2), ('Paper', 3)) AS d(value, ord)
       WHERE NOT EXISTS (
               SELECT 1 FROM option_lists o
                WHERE o.tenant_id = ?
                  AND o.list_key = 'line.packaging'
                  AND lower(o.value) = lower(d.value)
             );
      `,
      [tenant.id, tenant.id, tenant.id],
    );
  }
}

/**
 * Nothing to undo. The rows may be on lines by now, and Settings → Fields is
 * where a company removes a value it does not want.
 */
export async function down(): Promise<void> {}
