/**
 * The To-do list (2026-10-08): two tables and two grants, all additive and safe to run twice.
 *
 * **`todos`.** One row per task: its text, who wrote it, and its auto expiry — none, a fixed
 * time (`expires_at`), or a number of hours after it is completed (`expire_after_hours`), never
 * both. Soft-deleted (`deleted_at`, `deleted_by`); there is no Recycle Bin branch, so a deleted
 * task is gone from every screen for good.
 *
 * **`todo_marks`.** Who marked which task "In progress" or "Completed", and when. One row per
 * task, person and status, so marking twice is a no-op and a person's In progress mark stays
 * beside their Completed one. A task counts as completed from its earliest Completed mark.
 *
 * **The grants.** `todos.view` goes to **every** role, whatever its tier; `todos.manage` to
 * every role of the `admin` and `server_master` tiers. Union, never replace, idempotent: the
 * shape of `20261014000000_notice_board.ts`. A role created after this runs gets `todos.view`
 * from the role form's default.
 *
 * Key lists and tier names are inline, never read from `@orderbook/shared`.
 */

import type { Knex } from 'knex';

const VIEW = 'todos.view';
const MANAGE = 'todos.manage';
const MANAGE_TIERS = ['admin', 'server_master'] as const;

interface RoleRow {
  id: string;
  tenant_id: string;
  tier: string;
  permissions: unknown;
}

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS todos (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      text TEXT NOT NULL
        CONSTRAINT todos_text CHECK (char_length(btrim(text)) BETWEEN 1 AND 500),
      expires_at TIMESTAMPTZ NULL,
      expire_after_hours INTEGER NULL
        CONSTRAINT todos_expire_after_hours CHECK (expire_after_hours BETWEEN 1 AND 8760),
      created_by TEXT NULL REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      deleted_at TIMESTAMPTZ NULL,
      deleted_by TEXT NULL REFERENCES users(id),
      CONSTRAINT todos_one_expiry CHECK (expires_at IS NULL OR expire_after_hours IS NULL)
    )
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS todos_tenant_live_idx
      ON todos (tenant_id, created_at) WHERE deleted_at IS NULL
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS todo_marks (
      todo_id UUID NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id),
      status TEXT NOT NULL
        CONSTRAINT todo_marks_status CHECK (status IN ('in_progress', 'completed')),
      marked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (todo_id, user_id, status)
    )
  `);

  const roles = await knex('roles').select<RoleRow[]>('id', 'tenant_id', 'tier', 'permissions');
  for (const role of roles) {
    const stored = Array.isArray(role.permissions)
      ? role.permissions.filter((entry): entry is string => typeof entry === 'string')
      : [];

    const wanted = [
      VIEW,
      ...((MANAGE_TIERS as readonly string[]).includes(role.tier) ? [MANAGE] : []),
    ];
    if (wanted.every((key) => stored.includes(key))) continue;

    const merged = [...new Set([...stored, ...wanted])].sort();
    await knex('roles')
      .where({ id: role.id, tenant_id: role.tenant_id })
      .update({ permissions: JSON.stringify(merged) });
  }
}

export async function down(knex: Knex): Promise<void> {
  // The tables only, as the notice board's: an administrator may since have handed the keys on.
  await knex.raw('DROP TABLE IF EXISTS todo_marks');
  await knex.raw('DROP TABLE IF EXISTS todos');
}
