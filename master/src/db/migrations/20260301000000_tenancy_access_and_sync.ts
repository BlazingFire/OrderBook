/**
 * Tenancy, role-based access, configurable pipelines, and the offline sync
 * infrastructure (docs/LEAD_GENERATION_FLOW.md §1, §4, §7;
 * docs/schema/06-tenancy-permissions-and-sync.md).
 *
 * Runs before the lead/order rebuild because that migration needs the tenant,
 * the pipelines and the id sequences to already exist.
 *
 * Written as raw SQL rather than Knex's schema builder to stay
 * character-comparable with the schema docs — the same reason the initial
 * migration does. The exceptions are the seed steps, which import the
 * permission catalogue and device-code helper from `@orderbook/shared` instead
 * of restating them: a permission list duplicated in SQL is a permission list
 * that drifts.
 */

import { randomUUID } from 'node:crypto';

import { deviceCodeFromSeed } from '@orderbook/shared';
import type { Knex } from 'knex';

/**
 * The permission catalogue **as it stood when this migration was written**.
 *
 * Deliberately inlined rather than imported from `@orderbook/shared`. An earlier
 * version imported the live constant, and editing the catalogue later silently
 * changed what this migration had already done on every installation — a
 * migration has to be a fixed historical fact, not a view of today's code.
 * Later migrations remap these keys forward.
 */
const SEEDED_TIER_PERMISSIONS: Record<string, string[]> = {
  admin: [
    'leads.view', 'leads.create', 'leads.edit', 'leads.delete', 'lead.convert',
    'orders.view', 'orders.edit', 'orders.dispatch',
    'parties.view', 'parties.manage', 'products.view', 'products.manage',
    'inventory.view', 'inventory.manage',
    'record.reassignOwner',
    'settings.manage', 'users.manage', 'panels.manage', 'sync.resolveConflicts',
    'field.saleRate.view',
  ],
  management: [
    'leads.view', 'leads.create', 'leads.edit', 'leads.delete', 'lead.convert',
    'orders.view', 'orders.edit', 'orders.dispatch',
    'parties.view', 'parties.manage', 'products.view', 'products.manage',
    'inventory.view', 'inventory.manage',
    'record.reassignOwner', 'sync.resolveConflicts', 'field.saleRate.view',
  ],
  office: [
    'leads.view', 'leads.create', 'leads.edit', 'lead.convert',
    'orders.view', 'parties.view', 'parties.manage', 'products.view',
    'inventory.view', 'field.saleRate.view',
  ],
};

const SEEDED_TIERS = ['admin', 'management', 'office'] as const;

/** Tables that existed before tenancy and now need a tenant column. */
const EXISTING_TENANT_TABLES = [
  'users',
  'office_panels',
  'parties',
  'product_categories',
  'products',
  'product_images',
  'leads',
  'lead_items',
  'inventory_stock',
  'stock_movements',
  'activity_log',
] as const;

const LEAD_STAGES = [
  { name: 'New', sequence: 1, isDefault: true, isTerminal: false, colour: '#5B8DEF' },
  { name: 'Quoted', sequence: 2, isDefault: false, isTerminal: false, colour: '#9B7BEF' },
  { name: 'Negotiating', sequence: 3, isDefault: false, isTerminal: false, colour: '#EFA65B' },
  { name: 'Won', sequence: 4, isDefault: false, isTerminal: true, colour: '#4CAF7D' },
  { name: 'Lost', sequence: 5, isDefault: false, isTerminal: true, colour: '#C7576B' },
];

const ORDER_STAGES = [
  { name: 'In Progress', sequence: 1, isDefault: true, isTerminal: false, colour: '#5B8DEF' },
  { name: 'Postpone', sequence: 2, isDefault: false, isTerminal: false, colour: '#EFA65B' },
  { name: 'Dispatched', sequence: 3, isDefault: false, isTerminal: true, colour: '#4CAF7D' },
  { name: 'Cancelled', sequence: 4, isDefault: false, isTerminal: true, colour: '#C7576B' },
];

const SOURCE_PLATFORMS = [
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'call', label: 'Phone call' },
  { value: 'website', label: 'Website' },
  { value: 'walk_in', label: 'Walk-in' },
  { value: 'referral', label: 'Referral' },
  { value: 'other', label: 'Other' },
];

export async function up(knex: Knex): Promise<void> {
  // --- Tenants ------------------------------------------------------------

  await knex.raw(`
    CREATE TABLE tenants (
      id         UUID PRIMARY KEY,
      name       TEXT NOT NULL,
      slug       TEXT NOT NULL UNIQUE,
      is_active  BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // One installation is one company today. Everything is keyed by tenant anyway
  // so that a second one never requires a data migration — only a new row.
  const tenantId = randomUUID();
  const [existingConfig] = await knex
    .select<Array<{ company_name: string | null }>>('company_name')
    .from('master_config')
    .limit(1);
  const tenantName = existingConfig?.company_name?.trim() || 'Default';

  await knex('tenants').insert({
    id: tenantId,
    name: tenantName,
    slug: 'default',
    is_active: true,
  });

  // --- Tenant column on everything that predates tenancy -------------------

  for (const table of EXISTING_TENANT_TABLES) {
    await knex.raw(`ALTER TABLE ${table} ADD COLUMN tenant_id UUID;`);
    await knex(table).update({ tenant_id: tenantId });
    await knex.raw(`
      ALTER TABLE ${table}
        ALTER COLUMN tenant_id SET NOT NULL,
        ADD CONSTRAINT ${table}_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id);
      CREATE INDEX idx_${table}_tenant ON ${table}(tenant_id);
    `);
  }

  await knex.raw(`ALTER TABLE master_config ADD COLUMN tenant_id UUID REFERENCES tenants(id);`);
  await knex('master_config').update({ tenant_id: tenantId });

  // Codes were globally unique; they only ever needed to be unique per tenant.
  await knex.raw(`
    ALTER TABLE parties DROP CONSTRAINT IF EXISTS parties_party_code_key;
    ALTER TABLE products DROP CONSTRAINT IF EXISTS products_product_code_key;
    ALTER TABLE product_categories DROP CONSTRAINT IF EXISTS product_categories_name_key;
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_username_key;

    CREATE UNIQUE INDEX idx_parties_code_tenant     ON parties(tenant_id, party_code);
    CREATE UNIQUE INDEX idx_products_code_tenant    ON products(tenant_id, product_code);
    CREATE UNIQUE INDEX idx_categories_name_tenant  ON product_categories(tenant_id, lower(name));
    CREATE UNIQUE INDEX idx_users_username_tenant   ON users(tenant_id, lower(username));
  `);

  // --- Roles & permissions ------------------------------------------------

  await knex.raw(`
    CREATE TABLE roles (
      id         UUID PRIMARY KEY,
      tenant_id  UUID NOT NULL REFERENCES tenants(id),
      name       TEXT NOT NULL,
      tier       TEXT NOT NULL CHECK (tier IN ('admin', 'management', 'office')),
      is_system  BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX idx_roles_name_tenant ON roles(tenant_id, lower(name));

    CREATE TABLE role_permissions (
      role_id    UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      permission TEXT NOT NULL,
      PRIMARY KEY (role_id, permission)
    );
  `);

  // Seeded from the shared catalogue so the two can never disagree about what a
  // tier means. They are seeds, not law — an admin may re-grant them afterwards,
  // which is why the runtime check reads role_permissions, not the tier name.
  const roleIdByTier = new Map<string, string>();
  for (const tier of SEEDED_TIERS) {
    const id = randomUUID();
    roleIdByTier.set(tier, id);

    await knex('roles').insert({
      id,
      tenant_id: tenantId,
      name: tier.charAt(0).toUpperCase() + tier.slice(1),
      tier,
      is_system: true,
    });

    await knex('role_permissions').insert(
      (SEEDED_TIER_PERMISSIONS[tier] ?? []).map((permission) => ({ role_id: id, permission })),
    );
  }

  await knex.raw(`ALTER TABLE users ADD COLUMN role_id UUID REFERENCES roles(id);`);
  // The old two-value column maps straight onto the new tiers.
  await knex('users').where({ role: 'admin' }).update({ role_id: roleIdByTier.get('admin')! });
  await knex('users').whereNot({ role: 'admin' }).update({ role_id: roleIdByTier.get('office')! });
  await knex.raw(`ALTER TABLE users DROP COLUMN role;`);

  // --- Panel device codes -------------------------------------------------

  await knex.raw(`
    ALTER TABLE office_panels
      ADD COLUMN device_code TEXT,
      -- Which role this panel's commands act under. NULL falls back to the
      -- seeded Office tier, so a freshly paired panel can raise leads and
      -- nothing more until someone widens it deliberately.
      ADD COLUMN role_id UUID REFERENCES roles(id);
  `);

  // Derived from the panel id rather than stored randomly, so a panel that loses
  // its local files still recovers the same code and its old temporary ids
  // remain attributable to it.
  const panels = await knex.select<Array<{ id: string }>>('id').from('office_panels');
  for (const panel of panels) {
    await knex('office_panels')
      .where({ id: panel.id })
      .update({ device_code: deviceCodeFromSeed(panel.id) });
  }

  await knex.raw(`
    UPDATE office_panels SET device_code = 'MASTER' WHERE device_code IS NULL;
    ALTER TABLE office_panels ALTER COLUMN device_code SET NOT NULL;
    CREATE UNIQUE INDEX idx_office_panels_device ON office_panels(tenant_id, device_code);
  `);

  // --- Configurable pipelines (the Kanban columns) ------------------------

  await knex.raw(`
    CREATE TABLE pipelines (
      id         UUID PRIMARY KEY,
      tenant_id  UUID NOT NULL REFERENCES tenants(id),
      kind       TEXT NOT NULL CHECK (kind IN ('lead', 'order')),
      name       TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX idx_pipelines_tenant_kind ON pipelines(tenant_id, kind);

    CREATE TABLE pipeline_stages (
      id          UUID PRIMARY KEY,
      pipeline_id UUID NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      sequence    INTEGER NOT NULL,
      is_default  BOOLEAN NOT NULL DEFAULT false,
      is_terminal BOOLEAN NOT NULL DEFAULT false,
      colour      TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX idx_pipeline_stages_seq ON pipeline_stages(pipeline_id, sequence);
    CREATE INDEX        idx_pipeline_stages_pipeline ON pipeline_stages(pipeline_id);
  `);

  // Exactly one default stage per pipeline: new records must have exactly one
  // place to land, and a partial unique index makes that a database guarantee
  // rather than an application convention.
  await knex.raw(`
    CREATE UNIQUE INDEX idx_pipeline_stages_one_default
        ON pipeline_stages(pipeline_id) WHERE is_default;
  `);

  for (const [kind, stages, name] of [
    ['lead', LEAD_STAGES, 'Lead pipeline'],
    ['order', ORDER_STAGES, 'Order pipeline'],
  ] as const) {
    const pipelineId = randomUUID();
    await knex('pipelines').insert({ id: pipelineId, tenant_id: tenantId, kind, name });
    await knex('pipeline_stages').insert(
      stages.map((stage) => ({
        id: randomUUID(),
        pipeline_id: pipelineId,
        name: stage.name,
        sequence: stage.sequence,
        is_default: stage.isDefault,
        is_terminal: stage.isTerminal,
        colour: stage.colour,
      })),
    );
  }

  // --- Configurable option lists & custom fields --------------------------

  await knex.raw(`
    CREATE TABLE option_lists (
      id        UUID PRIMARY KEY,
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      list_key  TEXT NOT NULL,
      value     TEXT NOT NULL,
      label     TEXT NOT NULL,
      sequence  INTEGER NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT true
    );
    CREATE UNIQUE INDEX idx_option_lists_key_value ON option_lists(tenant_id, list_key, value);

    CREATE TABLE custom_field_definitions (
      id          UUID PRIMARY KEY,
      tenant_id   UUID NOT NULL REFERENCES tenants(id),
      entity      TEXT NOT NULL CHECK (entity IN ('lead', 'order', 'party', 'product')),
      key         TEXT NOT NULL,
      label       TEXT NOT NULL,
      field_type  TEXT NOT NULL CHECK (field_type IN ('text','number','date','select','boolean')),
      is_required BOOLEAN NOT NULL DEFAULT false,
      options     JSONB NOT NULL DEFAULT '[]',
      sequence    INTEGER NOT NULL DEFAULT 0,
      is_active   BOOLEAN NOT NULL DEFAULT true,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX idx_custom_fields_key ON custom_field_definitions(tenant_id, entity, key);
  `);

  await knex('option_lists').insert(
    SOURCE_PLATFORMS.map((option, index) => ({
      id: randomUUID(),
      tenant_id: tenantId,
      list_key: 'lead.sourcePlatform',
      value: option.value,
      label: option.label,
      sequence: index + 1,
      is_active: true,
    })),
  );

  // --- Offline sync infrastructure ---------------------------------------

  await knex.raw(`
    -- A temporary id and the permanent one it became. Kept forever: a docket
    -- printed offline must stay findable by the number on the paper.
    CREATE TABLE id_map (
      tenant_id    UUID NOT NULL REFERENCES tenants(id),
      entity       TEXT NOT NULL,
      temporary_id TEXT NOT NULL,
      permanent_id TEXT NOT NULL,
      device_code  TEXT NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, temporary_id)
    );
    CREATE INDEX idx_id_map_permanent ON id_map(tenant_id, permanent_id);

    -- Makes an outbox flush idempotent: a panel that crashes mid-push and
    -- resends gets the stored result back instead of applying twice.
    CREATE TABLE applied_mutations (
      tenant_id   UUID NOT NULL REFERENCES tenants(id),
      mutation_id TEXT NOT NULL,
      entity      TEXT NOT NULL,
      entity_id   TEXT NOT NULL,
      status      TEXT NOT NULL,
      result      JSONB NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, mutation_id)
    );
    CREATE INDEX idx_applied_mutations_at ON applied_mutations(tenant_id, applied_at);

    -- Field-level edits that lost a merge. Kept visible so a human can put the
    -- losing value back if it was the right one.
    CREATE TABLE sync_conflicts (
      id                  BIGSERIAL PRIMARY KEY,
      tenant_id           UUID NOT NULL REFERENCES tenants(id),
      entity              TEXT NOT NULL,
      entity_id           TEXT NOT NULL,
      field               TEXT NOT NULL,
      losing_value        JSONB,
      losing_hlc          TEXT NOT NULL,
      losing_device_code  TEXT NOT NULL,
      winning_value       JSONB,
      winning_hlc         TEXT NOT NULL,
      winning_device_code TEXT NOT NULL,
      resolved_at         TIMESTAMPTZ,
      resolved_by_user_id UUID REFERENCES users(id),
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_sync_conflicts_entity ON sync_conflicts(tenant_id, entity, entity_id);
    CREATE INDEX idx_sync_conflicts_open   ON sync_conflicts(tenant_id) WHERE resolved_at IS NULL;

    -- Per-entity counters behind permanent ids. A row-locked counter rather
    -- than a Postgres SEQUENCE because assignment must be gap-free and ordered
    -- by (hlc, device), which a sequence's concurrency guarantees cannot give.
    CREATE TABLE id_sequences (
      tenant_id  UUID NOT NULL REFERENCES tenants(id),
      entity     TEXT NOT NULL,
      next_value BIGINT NOT NULL DEFAULT 1,
      PRIMARY KEY (tenant_id, entity)
    );

    -- The Master's own HLC, persisted so restarts do not rewind it.
    CREATE TABLE master_clock (
      id          INTEGER PRIMARY KEY CHECK (id = 1),
      device_code TEXT NOT NULL,
      physical    BIGINT NOT NULL DEFAULT 0,
      counter     INTEGER NOT NULL DEFAULT 0
    );
  `);

  await knex('master_clock').insert({ id: 1, device_code: 'MASTER', physical: 0, counter: 0 });
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP TABLE IF EXISTS master_clock;
    DROP TABLE IF EXISTS id_sequences;
    DROP TABLE IF EXISTS sync_conflicts;
    DROP TABLE IF EXISTS applied_mutations;
    DROP TABLE IF EXISTS id_map;
    DROP TABLE IF EXISTS custom_field_definitions;
    DROP TABLE IF EXISTS option_lists;
    DROP TABLE IF EXISTS pipeline_stages;
    DROP TABLE IF EXISTS pipelines;
  `);

  await knex.raw(`
    ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin';
    ALTER TABLE users DROP COLUMN IF EXISTS role_id;
    DROP TABLE IF EXISTS role_permissions;
    DROP TABLE IF EXISTS roles;
  `);

  await knex.raw(`
    DROP INDEX IF EXISTS idx_office_panels_device;
    ALTER TABLE office_panels DROP COLUMN IF EXISTS role_id;
    ALTER TABLE office_panels DROP COLUMN IF EXISTS device_code;

    DROP INDEX IF EXISTS idx_users_username_tenant;
    DROP INDEX IF EXISTS idx_categories_name_tenant;
    DROP INDEX IF EXISTS idx_products_code_tenant;
    DROP INDEX IF EXISTS idx_parties_code_tenant;
  `);

  for (const table of EXISTING_TENANT_TABLES) {
    await knex.raw(`
      DROP INDEX IF EXISTS idx_${table}_tenant;
      ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_tenant_fk;
      ALTER TABLE ${table} DROP COLUMN IF EXISTS tenant_id;
    `);
  }

  await knex.raw(`ALTER TABLE master_config DROP COLUMN IF EXISTS tenant_id;`);
  await knex.raw(`DROP TABLE IF EXISTS tenants;`);
}
