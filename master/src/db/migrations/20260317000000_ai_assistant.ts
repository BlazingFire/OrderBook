/**
 * One table for the assistant's runs, and three permission keys.
 *
 * `ai_runs` holds the prompt, the answer, what the model looked at and what it
 * cost. It is the only place a transcript lives, and it ages out on
 * `ai.retentionDays` — which is why the audit entry beside it carries figures
 * only. `activity_log` is append-only by trigger and is swept by nothing, so a
 * prompt written there would be permanent.
 *
 * `user_id` is TEXT with no foreign key, matching `party_access.user_id`:
 * `users.id` is TEXT, people are soft-deleted and restorable, and a cascade
 * would erase somebody's transcripts the moment they were deactivated.
 *
 * The grants are JavaScript with every literal inlined, per
 * `20260311000000_storage_permission_grant.ts`: `role_permissions` was dropped
 * three migrations after it was created, and importing the live catalogue would
 * make a fixed historical fact change retroactively.
 */

import type { Knex } from 'knex';

interface RoleRow {
  id: string;
  tenant_id: string;
  permissions: unknown;
}

/** Inlined and frozen. Never imported from `@orderbook/shared`. */
const ADMIN_KEYS = ['ai.manage', 'ai.write'];
const USE_KEY = 'ai.use';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('ai_runs', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    table.text('user_id').notNullable();
    table.uuid('panel_id').nullable();
    table.text('kind').notNullable();
    table.text('model').nullable();
    table.text('subject_kind').nullable();
    table.text('subject_id').nullable();
    table.text('prompt').notNullable();
    table.text('answer').nullable();
    table.jsonb('tool_trace').notNullable().defaultTo('[]');
    table.jsonb('proposal').nullable();
    table.timestamp('applied_at', { useTz: true }).nullable();
    table.text('applied_by').nullable();
    table.integer('prompt_tokens').nullable();
    table.integer('completion_tokens').nullable();
    table.text('status').notNullable().defaultTo('running');
    table.text('error_code').nullable();
    table.integer('latency_ms').nullable();
    /*
     * What the asker could see when they asked.
     *
     * Enforced on *read*, not only at write time: somebody who has since lost
     * `field.saleRate.view` must not get their old transcripts back, because a
     * transcript can contain the rates they were shown.
     */
    table.boolean('rates_visible').notNullable().defaultTo(false);
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('finished_at', { useTz: true }).nullable();

    table.index(['tenant_id', 'user_id', 'created_at']);
    table.index(['tenant_id', 'created_at']);
  });

  await knex.raw(
    "ALTER TABLE ai_runs ADD CONSTRAINT ai_runs_kind_check CHECK (kind IN ('ask','draft','summarise','vision','narrate'))",
  );
  await knex.raw(
    "ALTER TABLE ai_runs ADD CONSTRAINT ai_runs_status_check CHECK (status IN ('running','done','cancelled','failed'))",
  );

  const roles = await knex<RoleRow>('roles').select('id', 'tenant_id', 'permissions');

  for (const role of roles) {
    const stored = Array.isArray(role.permissions)
      ? role.permissions.filter((entry): entry is string => typeof entry === 'string')
      : [];

    const next = new Set(stored);
    // Whoever administers this installation configures the assistant and may
    // accept what it suggests.
    if (stored.includes('settings.manage')) for (const key of ADMIN_KEYS) next.add(key);
    // Whoever works leads may ask it a question: it can read nothing they
    // could not already read.
    if (stored.includes('leads.view')) next.add(USE_KEY);

    if (next.size === stored.length) continue;

    await knex('roles')
      .where({ id: role.id, tenant_id: role.tenant_id })
      .update({ permissions: JSON.stringify([...next].sort()) });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('ai_runs');

  const revoked = new Set([...ADMIN_KEYS, USE_KEY]);
  const roles = await knex<RoleRow>('roles').select('id', 'tenant_id', 'permissions');

  for (const role of roles) {
    const stored = Array.isArray(role.permissions)
      ? role.permissions.filter((entry): entry is string => typeof entry === 'string')
      : [];

    const next = stored.filter((key) => !revoked.has(key));
    if (next.length === stored.length) continue;

    await knex('roles')
      .where({ id: role.id, tenant_id: role.tenant_id })
      .update({ permissions: JSON.stringify(next.sort()) });
  }
}
