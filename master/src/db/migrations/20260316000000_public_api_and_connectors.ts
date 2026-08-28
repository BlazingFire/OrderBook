/**
 * The public API's keys, and the outbound connector's tables.
 *
 * **The `api.manage` grant is JavaScript, not SQL.** `role_permissions` was
 * dropped at `20260303000000_roles_and_users.ts:78` and permissions have lived
 * as a JSONB array on `roles.permissions` ever since. An
 * `INSERT INTO role_permissions …` here would raise `relation does not exist`,
 * abort the transaction, and boot the Master to its migration-failure page.
 * This follows `20260311000000_storage_permission_grant.ts` exactly, including
 * inlining and freezing the key list: a migration is a fixed historical fact,
 * and importing the live catalogue would make it change retroactively.
 *
 * **Every table here carries `tenant_id`, child tables included.**
 * `backup.repository.ts`'s `tenantScopedTables()` decides selected-scope
 * export and restore purely on that column's presence, and `loadTables` leaves
 * a tenant-less table untouched — so a scope table without one would survive a
 * selected restore and stay bound to ids that no longer exist.
 *
 * **No `master_config.api_enabled` column.** The switch is the
 * `externalApi.enabled` setting, which the settings table already holds. One
 * fewer schema change, and one fewer place the answer can live.
 *
 * `id_map` is deliberately not reused for remote ids: its primary key is
 * `(tenant_id, temporary_id)` with no connector column, and `resolveId` treats
 * any id as a possible temporary one — a remote `SO-1042` in there would
 * silently rewrite an unrelated lookup.
 */

import type { Knex } from 'knex';

interface RoleRow {
  id: string;
  tenant_id: string;
  permissions: unknown;
}

const GRANTED = 'api.manage';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('api_keys', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    table.text('label').notNullable();
    // The lookup handle. Unique because it is what an incoming request is found
    // by, and displayed because it is not a secret.
    table.text('token_prefix').notNullable().unique();
    table.text('token_hash').notNullable();
    /*
     * TEXT and no foreign key, matching `party_access.user_id`.
     *
     * `users.id` is TEXT, and users are soft-deleted and restorable — a
     * cascade here would silently delete the keys of somebody who was
     * deactivated and then brought back. The service checks the owner exists
     * and is live at the moment a key is issued, and authentication re-checks
     * it on every request.
     */
    table.text('owner_user_id').notNullable();
    table.integer('rate_limit_per_min').notNullable().defaultTo(120);
    table.timestamp('expires_at', { useTz: true }).nullable();
    table.timestamp('revoked_at', { useTz: true }).nullable();
    table.timestamp('last_used_at', { useTz: true }).nullable();
    table.text('created_by_user_id').nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.index(['tenant_id']);
  });

  await knex.schema.createTable('api_key_scopes', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    table.uuid('api_key_id').notNullable().references('id').inTable('api_keys').onDelete('CASCADE');
    table.text('permission').notNullable();
    table.unique(['api_key_id', 'permission']);
  });

  await knex.schema.createTable('api_connectors', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    table.text('slug').notNullable();
    table.text('label').notNullable();
    table.text('base_url').notNullable();
    table.text('auth_kind').notNullable().defaultTo('none');
    table.text('auth_header').nullable();
    table.text('auth_username').nullable();
    /*
     * The credential, sealed by `secret-box` with this row's own AAD — never a
     * plaintext column, and never a column called `secret_key`, which would be a
     * trap for the next person to grep an unencrypted backup.
     */
    table.jsonb('credential_sealed').nullable();
    table.text('direction').notNullable().defaultTo('inbound');
    table.text('schedule_kind').notNullable().defaultTo('manual');
    table.integer('interval_min').nullable();
    // Whose authority an import writes with. Nullable so a connector can exist
    // before somebody decides; a run without it is refused rather than falling
    // back to the system actor, which holds no permissions at all. TEXT and
    // unreferenced for the same reason as `owner_user_id` above.
    table.text('run_as_user_id').nullable();
    table.integer('mapping_version').notNullable().defaultTo(1);
    table.text('profile_slug').nullable();
    table.boolean('is_enabled').notNullable().defaultTo(false);
    table.timestamp('last_run_at', { useTz: true }).nullable();
    table.text('last_status').nullable();
    table.text('last_error').nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.unique(['tenant_id', 'slug']);
  });

  await knex.schema.createTable('api_connector_resources', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    table
      .uuid('connector_id')
      .notNullable()
      .references('id')
      .inTable('api_connectors')
      .onDelete('CASCADE');
    table.text('entity').notNullable();
    table.text('path').notNullable();
    table.text('method').notNullable().defaultTo('GET');
    table.text('items_pointer').notNullable().defaultTo('');
    table.text('remote_id_pointer').notNullable();
    table.text('updated_at_pointer').nullable();
    table.text('page_param').nullable();
    table.text('page_size_param').nullable();
    table.integer('page_size').nullable();
    table.text('watermark').nullable();
    table.unique(['connector_id', 'entity']);
  });

  await knex.schema.createTable('api_connector_field_maps', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    table
      .uuid('resource_id')
      .notNullable()
      .references('id')
      .inTable('api_connector_resources')
      .onDelete('CASCADE');
    table.text('local_field').notNullable();
    table.text('remote_pointer').notNullable();
    table.text('transform').nullable();
    table.text('on_conflict').notNullable().defaultTo('remote_wins');
    table.boolean('is_required').notNullable().defaultTo(false);
    table.unique(['resource_id', 'local_field']);
  });

  await knex.schema.createTable('api_connector_links', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    table
      .uuid('connector_id')
      .notNullable()
      .references('id')
      .inTable('api_connectors')
      .onDelete('CASCADE');
    table.text('entity').notNullable();
    table.text('remote_id').notNullable();
    /*
     * No foreign key, deliberately. A local record can be deleted through the
     * Recycle Bin while the remote one lives on; a link whose target is gone is
     * treated as a create on the next run, which is the behaviour somebody
     * expects after deleting a row by mistake.
     */
    table.text('local_id').notNullable();
    table.text('remote_hash').notNullable();
    table.timestamp('last_seen_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.unique(['connector_id', 'entity', 'remote_id']);
  });

  await knex.schema.createTable('api_connector_runs', (table) => {
    table.bigIncrements('id').primary();
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    table
      .uuid('connector_id')
      .notNullable()
      .references('id')
      .inTable('api_connectors')
      .onDelete('CASCADE');
    table.text('mode').notNullable();
    table.text('trigger').notNullable();
    table.integer('mapping_version').notNullable();
    table.timestamp('started_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('finished_at', { useTz: true }).nullable();
    table.text('status').notNullable().defaultTo('running');
    table.integer('read_count').notNullable().defaultTo(0);
    table.integer('created_count').notNullable().defaultTo(0);
    table.integer('updated_count').notNullable().defaultTo(0);
    table.integer('skipped_count').notNullable().defaultTo(0);
    table.integer('failed_count').notNullable().defaultTo(0);
    table.jsonb('errors').notNullable().defaultTo('[]');
    table.index(['connector_id', 'started_at']);
  });

  /*
   * `actor_type`'s CHECK gains the two new principals.
   *
   * `activity_log_actor_type_check` is the auto-generated name of the inline
   * CHECK from `20260101000000_initial_schema.ts`, and the table has never been
   * recreated since. This is DDL, so the append-only trigger never fires.
   */
  await knex.raw(
    'ALTER TABLE activity_log DROP CONSTRAINT IF EXISTS activity_log_actor_type_check',
  );
  await knex.raw(
    "ALTER TABLE activity_log ADD CONSTRAINT activity_log_actor_type_check CHECK (actor_type IN ('user','office_panel','system','api_key','connector'))",
  );

  const roles = await knex<RoleRow>('roles').select('id', 'tenant_id', 'permissions');
  for (const role of roles) {
    const stored = Array.isArray(role.permissions)
      ? role.permissions.filter((entry): entry is string => typeof entry === 'string')
      : [];

    // Admin tier only. Every other role receives it through the permission grid,
    // deliberately: this key mints credentials.
    if (!stored.includes('settings.manage') || stored.includes(GRANTED)) continue;

    await knex('roles')
      .where({ id: role.id, tenant_id: role.tenant_id })
      .update({ permissions: JSON.stringify([...new Set([...stored, GRANTED])].sort()) });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('api_connector_runs');
  await knex.schema.dropTableIfExists('api_connector_links');
  await knex.schema.dropTableIfExists('api_connector_field_maps');
  await knex.schema.dropTableIfExists('api_connector_resources');
  await knex.schema.dropTableIfExists('api_connectors');
  await knex.schema.dropTableIfExists('api_key_scopes');
  await knex.schema.dropTableIfExists('api_keys');

  await knex.raw(
    'ALTER TABLE activity_log DROP CONSTRAINT IF EXISTS activity_log_actor_type_check',
  );
  await knex.raw(
    "ALTER TABLE activity_log ADD CONSTRAINT activity_log_actor_type_check CHECK (actor_type IN ('user','office_panel','system'))",
  );

  const roles = await knex<RoleRow>('roles').select('id', 'tenant_id', 'permissions');
  for (const role of roles) {
    const stored = Array.isArray(role.permissions)
      ? role.permissions.filter((entry): entry is string => typeof entry === 'string')
      : [];

    if (!stored.includes(GRANTED)) continue;

    await knex('roles')
      .where({ id: role.id, tenant_id: role.tenant_id })
      .update({ permissions: JSON.stringify(stored.filter((key) => key !== GRANTED).sort()) });
  }
}
