/**
 * Roles & Users (docs/ROLES_AND_USERS.md).
 *
 * Five changes that have to land together, because each depends on the others:
 *
 *  1. **Permissions become one JSON array on the role**, replacing the
 *     `role_permissions` join table. Permission sets are approved as a whole, so
 *     they must merge as a whole: a per-key merge of two offline edits produces
 *     a union granting a combination neither administrator reviewed (§5).
 *  2. **Text ids** for roles (`RL…`) and users (`US…`), because both can be
 *     created on a panel with no link to the Master (§14). Six columns
 *     referencing `users(id)` move with them.
 *  3. **Soft delete** on both, so a restored role reattaches to the users still
 *     pointing at it — which is also why `users.role_id` is deliberately *not*
 *     a SQL foreign key (§4.1).
 *  4. **A tier ceiling**, stored per role and enforced on write and at sign-in.
 *  5. **A hash-chained audit trail**: `activity_log` becomes append-only by
 *     trigger, with each row committing to its predecessor.
 */

import { allPermissions } from '@orderbook/shared';
import type { Knex } from 'knex';

interface Reference {
  table: string;
  column: string;
}

/**
 * Every column with a foreign key into `users`, discovered from the catalog.
 *
 * Deliberately not a hand-written list. The first version of this migration
 * carried one and it was wrong — it named a `products.created_by_user_id` that
 * does not exist, and would equally have missed a column added between writing
 * and running. Asking Postgres what actually references the table cannot drift.
 */
async function userReferences(knex: Knex): Promise<Reference[]> {
  const { rows } = await knex.raw<{ rows: Array<{ table_name: string; column_name: string }> }>(`
    SELECT tc.table_name, kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name
       AND kcu.table_schema    = tc.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
       AND ccu.table_schema    = tc.table_schema
     WHERE tc.constraint_type = 'FOREIGN KEY'
       AND tc.table_schema    = 'public'
       AND ccu.table_name     = 'users'
     ORDER BY tc.table_name, kcu.column_name
  `);

  return rows.map((row) => ({ table: row.table_name, column: row.column_name }));
}

export async function up(knex: Knex): Promise<void> {
  const tenant = await firstTenantId(knex);
  // Captured before the keys are dropped in Phase E.
  const USER_REFERENCES = await userReferences(knex);

  // ======================================================================
  // Phase A — permissions become an array on the role
  // ======================================================================

  await knex.raw(`ALTER TABLE roles ADD COLUMN permissions JSONB NOT NULL DEFAULT '[]';`);

  // Sorted on the way in, so two identical sets are identical bytes and a
  // reorder never reads as an edit.
  await knex.raw(`
    UPDATE roles r
       SET permissions = COALESCE((
             SELECT jsonb_agg(rp.permission ORDER BY rp.permission)
               FROM role_permissions rp
              WHERE rp.role_id = r.id
           ), '[]'::jsonb);
  `);

  await knex.raw(`DROP TABLE role_permissions;`);

  // The catalogue got finer at the same time: `parties.manage` became
  // create/edit/delete, and `inventory.manage` split into an edit action and a
  // stock.adjust capability. Remapping here is what stops an existing role
  // silently losing access — an unknown key is filtered out at sign-in, so
  // without this a Management role would quietly stop being able to edit a
  // party and nothing would say why.
  const KEY_REMAP: Record<string, string[]> = {
    'parties.manage': ['parties.create', 'parties.edit', 'parties.delete'],
    'products.manage': ['products.create', 'products.edit', 'products.delete'],
    'inventory.manage': ['inventory.edit', 'stock.adjust'],
  };

  const roleRows = await knex('roles').select<Array<{ id: string; permissions: string[] }>>(
    'id',
    'permissions',
  );

  for (const role of roleRows) {
    const current = Array.isArray(role.permissions) ? role.permissions : [];
    const mapped = new Set<string>();

    for (const key of current) {
      for (const replacement of KEY_REMAP[key] ?? [key]) mapped.add(replacement);
    }

    await knex('roles')
      .where({ id: role.id })
      .update({ permissions: JSON.stringify([...mapped].sort()) });
  }

  // ======================================================================
  // Phase B — soft delete and sync bookkeeping on both tables
  // ======================================================================

  for (const table of ['roles', 'users']) {
    await knex.raw(`
      ALTER TABLE ${table}
        ADD COLUMN created_by   TEXT,
        ADD COLUMN updated_by   TEXT,
        ADD COLUMN deleted_at   TIMESTAMPTZ,
        ADD COLUMN deleted_by   TEXT,
        ADD COLUMN version      INTEGER NOT NULL DEFAULT 1,
        ADD COLUMN hlc          TEXT,
        ADD COLUMN field_hlc    JSONB NOT NULL DEFAULT '{}',
        ADD COLUMN temporary_id TEXT;
    `);
  }

  // `full_name` was optional; a person's display name is not.
  await knex.raw(`
    ALTER TABLE users RENAME COLUMN full_name TO display_name;
    UPDATE users SET display_name = username WHERE display_name IS NULL OR display_name = '';
    ALTER TABLE users ALTER COLUMN display_name SET NOT NULL;
    ALTER TABLE users RENAME COLUMN last_login_at TO last_sign_in_at;
  `);

  // ======================================================================
  // Phase C — stage text ids for roles and users
  // ======================================================================

  for (const [table, prefix] of [
    ['roles', 'RL'],
    ['users', 'US'],
  ] as const) {
    await knex.raw(`ALTER TABLE ${table} ADD COLUMN new_id TEXT;`);
    await knex.raw(`
      WITH numbered AS (
        SELECT id,
               '${prefix}' || lpad((ROW_NUMBER() OVER (ORDER BY created_at, id))::text, 10, '0') AS nid
          FROM ${table}
      )
      UPDATE ${table} t SET new_id = n.nid FROM numbered n WHERE t.id = n.id;
    `);
  }

  // ======================================================================
  // Phase D — repoint everything that referenced a role or a user
  // ======================================================================

  for (const { table, column } of USER_REFERENCES) {
    await knex.raw(`ALTER TABLE ${table} ADD COLUMN ${column}_new TEXT;`);
    await knex.raw(`
      UPDATE ${table} t SET ${column}_new = u.new_id
        FROM users u WHERE u.id = t.${column};
    `);
    await knex.raw(`
      ALTER TABLE ${table} DROP COLUMN ${column};
      ALTER TABLE ${table} RENAME COLUMN ${column}_new TO ${column};
    `);
  }

  // `activity_log.actor_id` holds a user id or a panel id, so it is text either
  // way and only the user-shaped values need rewriting.
  await knex.raw(`ALTER TABLE activity_log ALTER COLUMN actor_id TYPE TEXT USING actor_id::text;`);
  await knex.raw(`
    UPDATE activity_log a SET actor_id = u.new_id
      FROM users u WHERE a.actor_id = u.id::text;
  `);

  for (const table of ['users', 'office_panels']) {
    await knex.raw(`ALTER TABLE ${table} ADD COLUMN role_id_new TEXT;`);
    await knex.raw(`
      UPDATE ${table} t SET role_id_new = r.new_id FROM roles r WHERE r.id = t.role_id;
    `);
    await knex.raw(`
      ALTER TABLE ${table} DROP COLUMN role_id;
      ALTER TABLE ${table} RENAME COLUMN role_id_new TO role_id;
    `);
  }

  // ======================================================================
  // Phase E — swap the primary keys
  // ======================================================================

  for (const table of ['roles', 'users']) {
    await knex.raw(`
      ALTER TABLE ${table} DROP CONSTRAINT ${table}_pkey CASCADE;
      ALTER TABLE ${table} DROP COLUMN id;
      ALTER TABLE ${table} RENAME COLUMN new_id TO id;
      ALTER TABLE ${table} ALTER COLUMN id SET NOT NULL;
      ALTER TABLE ${table} ADD PRIMARY KEY (id);
    `);
  }

  // Restored, now that users(id) is text again. `role_id` deliberately gets no
  // foreign key: an op creating a user can arrive before the op creating its
  // role, and a hard FK would reject the projection and break idempotent
  // replay. Referential integrity for it lives in the service layer (§4.1).
  for (const { table, column } of USER_REFERENCES) {
    await knex.raw(`
      ALTER TABLE ${table}
        ADD CONSTRAINT ${table}_${column}_fk FOREIGN KEY (${column}) REFERENCES users(id);
    `);
  }

  // ======================================================================
  // Phase F — indexes
  // ======================================================================

  // Partial on live rows: without that, a soft-deleted user permanently
  // reserves their username and someone who left and came back cannot be
  // re-created.
  await knex.raw(`
    DROP INDEX IF EXISTS idx_roles_name_tenant;
    DROP INDEX IF EXISTS idx_users_username_tenant;

    CREATE UNIQUE INDEX roles_name_unique
      ON roles (tenant_id, lower(name)) WHERE deleted_at IS NULL;

    CREATE UNIQUE INDEX users_username_unique
      ON users (tenant_id, lower(username)) WHERE deleted_at IS NULL;

    CREATE INDEX users_by_role
      ON users (tenant_id, role_id) WHERE deleted_at IS NULL;

    CREATE INDEX users_active
      ON users (tenant_id, is_active) WHERE deleted_at IS NULL;
  `);

  // ======================================================================
  // Phase G — the audit trail becomes a hash chain
  // ======================================================================

  await knex.raw(`
    ALTER TABLE activity_log
      ADD COLUMN sequence  BIGINT,
      ADD COLUMN prev_hash TEXT,
      ADD COLUMN hash      TEXT;
  `);

  await knex.raw(`
    CREATE FUNCTION activity_log_chain() RETURNS trigger AS $$
    DECLARE
      last_hash TEXT;
      last_seq  BIGINT;
    BEGIN
      -- Serialises appends per tenant for the life of the transaction. Without
      -- it two concurrent inserts read the same predecessor and the chain forks.
      PERFORM pg_advisory_xact_lock(hashtext(NEW.tenant_id::text));

      SELECT hash, sequence INTO last_hash, last_seq
        FROM activity_log
       WHERE tenant_id = NEW.tenant_id
       ORDER BY sequence DESC
       LIMIT 1;

      NEW.sequence  := COALESCE(last_seq, 0) + 1;
      NEW.prev_hash := COALESCE(last_hash, repeat('0', 64));
      NEW.hash := encode(sha256(convert_to(
          NEW.prev_hash          || '|' ||
          NEW.sequence::text     || '|' ||
          NEW.entity_type        || '|' ||
          NEW.entity_id          || '|' ||
          NEW.action             || '|' ||
          NEW.actor_type         || '|' ||
          COALESCE(NEW.actor_id, '')      || '|' ||
          COALESCE(NEW.details::text, ''), 'UTF8')), 'hex');

      RETURN NEW;
    END $$ LANGUAGE plpgsql;

    CREATE TRIGGER activity_log_chain_trg
      BEFORE INSERT ON activity_log
      FOR EACH ROW EXECUTE FUNCTION activity_log_chain();
  `);

  // Backfill the chain over whatever is already there, oldest first.
  const existing = await knex('activity_log').orderBy('id').select('id');
  if (existing.length > 0) {
    await knex.raw(`
      WITH ordered AS (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY tenant_id ORDER BY id) AS seq
          FROM activity_log
      )
      UPDATE activity_log a SET sequence = o.seq FROM ordered o WHERE o.id = a.id;
    `);
    // Pre-chain rows are marked rather than given a forged hash: claiming a
    // verified chain over entries written before chaining existed would be a lie.
    await knex.raw(`
      UPDATE activity_log
         SET prev_hash = repeat('0', 64), hash = 'pre-chain'
       WHERE hash IS NULL;
    `);
  }

  await knex.raw(`
    CREATE FUNCTION activity_log_immutable() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'activity_log is append-only';
    END $$ LANGUAGE plpgsql;

    CREATE TRIGGER activity_log_no_update
      BEFORE UPDATE ON activity_log
      FOR EACH ROW EXECUTE FUNCTION activity_log_immutable();

    CREATE TRIGGER activity_log_no_delete
      BEFORE DELETE ON activity_log
      FOR EACH ROW EXECUTE FUNCTION activity_log_immutable();
  `);

  // ======================================================================
  // Phase H — only Administrator is a system role
  // ======================================================================

  // The previous migration marked all three seeded tiers `is_system`, which made
  // Management and Office undeletable. §13 is explicit that only Administrator
  // ships with a company; the other two are templates a company may edit or
  // remove, so they lose the protection rather than the row.
  await knex.raw(`UPDATE roles SET is_system = false WHERE tier <> 'admin';`);
  await knex('roles')
    .where({ tenant_id: tenant, tier: 'admin' })
    .update({ permissions: JSON.stringify(allPermissions()), is_system: true });

  // ======================================================================
  // Phase I — id counters for the two new entities
  // ======================================================================

  for (const [entity, table] of [
    ['role', 'roles'],
    ['user', 'users'],
  ] as const) {
    const { rows } = await knex.raw<{ rows: Array<{ next: string }> }>(
      `SELECT COALESCE(MAX(substring(id from 3)::bigint), 0) + 1 AS next
         FROM ${table} WHERE tenant_id = ? AND id ~ '^[A-Z]{2}[0-9]{10}$'`,
      [tenant],
    );

    await knex('id_sequences')
      .insert({ tenant_id: tenant, entity, next_value: Number(rows[0]?.next ?? 1) })
      .onConflict(['tenant_id', 'entity'])
      .merge();
  }
}

export async function down(): Promise<void> {
  // Irreversible for the same reason as the lead/order rebuild: reversing it
  // means inventing UUIDs to replace text ids, re-splitting one permission array
  // into join rows, and discarding a hash chain that cannot be recomputed after
  // the fact. Restore from a backup instead.
  throw new Error(
    'Migration 20260303000000_roles_and_users cannot be rolled back — restore from a backup.',
  );
}

async function firstTenantId(knex: Knex): Promise<string> {
  const row = await knex('tenants').orderBy('created_at').first<{ id: string }>('id');
  if (!row) throw new Error('No tenant found — the tenancy migration must run first');
  return row.id;
}
