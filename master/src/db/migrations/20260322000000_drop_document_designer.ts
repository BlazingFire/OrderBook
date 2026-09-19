/**
 * The PDF Designer is gone — drop what it left behind.
 *
 * `20260308000000_document_templates_and_exports` created three tables for the
 * Documents module (templates, the logo/signature assets they drew, and the
 * ledger of every rendered file), and `20260318000000_document_layout_v2`
 * rewrote the templates' layout column. Both migrations stay in the registry
 * as the historical facts they are — Knex refuses to start when a completed
 * migration vanishes from the list — and this one removes their tables, in
 * reverse dependency order: exports reference templates, templates reference
 * assets.
 *
 * The rendered files under `data/documents/` are **not** deleted here, for the
 * reason `20260308`'s own `down()` gave: a migration must not delete a
 * company's rendered quotations. Nothing in the product reads that folder any
 * more; an operator who wants the disk back removes it by hand.
 *
 * The second half strips the module's five permission keys from every stored
 * role, soft-deleted ones included. Enforcement never needed this —
 * `effectivePermissions` drops a key the catalogue no longer knows on every
 * resolution — but the role editor would otherwise render an unknown key it
 * cannot show, and a row on disk should match what the product can enforce.
 * The key list is **inlined and frozen as of 2026-09-19**, never imported from
 * `@orderbook/shared`, for the reason every migration here states: the live
 * catalogue changes, and a migration must not.
 *
 * `down()` restores nothing. The tables' contents are gone once this has run,
 * and the keys cannot be handed back because this migration cannot tell a
 * `20260309` admin grant from one an administrator ticked in the grid.
 */

import type { Knex } from 'knex';

const REMOVED_KEYS = new Set([
  'documents.create',
  'documents.delete',
  'documents.edit',
  'documents.render',
  'documents.view',
]);

interface RoleRow {
  id: string;
  tenant_id: string;
  permissions: unknown;
}

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP TABLE IF EXISTS document_exports;
    DROP TABLE IF EXISTS document_templates;
    DROP TABLE IF EXISTS document_assets;
  `);

  const roles = await knex('roles').select<RoleRow[]>('id', 'tenant_id', 'permissions');

  for (const role of roles) {
    const stored = Array.isArray(role.permissions)
      ? role.permissions.filter((entry): entry is string => typeof entry === 'string')
      : [];

    const kept = stored.filter((permission) => !REMOVED_KEYS.has(permission));

    // A filter cannot lengthen an array, so a length test is a correct no-op
    // check here — the same reasoning `20260304` gives for its own.
    if (kept.length === stored.length) continue;

    await knex('roles')
      .where({ id: role.id, tenant_id: role.tenant_id })
      .update({ permissions: JSON.stringify(kept) });
  }
}

export async function down(): Promise<void> {
  // Deliberately empty — see the header.
}
