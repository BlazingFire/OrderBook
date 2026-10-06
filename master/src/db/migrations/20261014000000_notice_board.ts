/**
 * The notice board (Oct 2026): three tables and two grants, all additive and safe to run twice.
 *
 * **`notices`.** One row per notice: a title, a plain-text body, a priority, a pin, an optional
 * last day to show (`show_until`, a calendar day in the company's time zone, compared by the
 * Master), and whether it is for everybody (`audience_all`) or for the roles named in
 * `notice_audiences`. `version` rises on every edit, so two administrators cannot overwrite
 * each other. A notice is soft-deleted (`deleted_at`, `deleted_by`) and comes back from the
 * Recycle Bin. `author_id` is the user who wrote it; users are soft-deleted and restorable,
 * never removed, so the reference cannot dangle.
 *
 * **`notice_audiences`.** The roles a notice is for, when it is not for everybody. Roles are
 * soft-deleted too, so a reference to one never dangles either.
 *
 * **`notice_reads`.** Who has read which notice, and when. It is what the unread badge counts
 * and what a manager sees as "read by". Unique per person per notice, so reading twice is a
 * no-op.
 *
 * **The grants.** `notices.view` goes to **every** role, whatever its tier, so nobody loses
 * anything they had and everybody can read the board; `notices.manage` goes to every role of
 * the `admin` and `server_master` tiers. Union, never replace, and idempotent: the shape and
 * reasoning of `20261005000000_chatroom.ts` (no tenant filter and no `deleted_at` filter, so a
 * restored role comes back holding what its siblings hold). A role created after this runs
 * gets `notices.view` from the role form's default, not from here.
 *
 * Key lists and tier names are inline, never read from `@orderbook/shared`: a migration must
 * not change meaning when a shared constant does.
 */

import type { Knex } from 'knex';

const VIEW = 'notices.view';
const MANAGE = 'notices.manage';
const MANAGE_TIERS = ['admin', 'server_master'] as const;

interface RoleRow {
  id: string;
  tenant_id: string;
  tier: string;
  permissions: unknown;
}

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS notices (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      title TEXT NOT NULL
        CONSTRAINT notices_title CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
      body TEXT NOT NULL DEFAULT ''
        CONSTRAINT notices_body CHECK (char_length(body) <= 4000),
      priority TEXT NOT NULL DEFAULT 'normal'
        CONSTRAINT notices_priority CHECK (priority IN ('normal', 'important')),
      pinned BOOLEAN NOT NULL DEFAULT false,
      show_until DATE NULL,
      audience_all BOOLEAN NOT NULL DEFAULT true,
      author_id TEXT NULL REFERENCES users(id),
      version INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      deleted_at TIMESTAMPTZ NULL,
      deleted_by TEXT NULL REFERENCES users(id)
    )
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS notices_board_idx
      ON notices (tenant_id, pinned DESC, created_at DESC, id)
      WHERE deleted_at IS NULL
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS notice_audiences (
      notice_id UUID NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
      role_id TEXT NOT NULL REFERENCES roles(id),
      PRIMARY KEY (notice_id, role_id)
    )
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS notice_audiences_role_idx ON notice_audiences (role_id)
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS notice_reads (
      notice_id UUID NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id),
      read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (notice_id, user_id)
    )
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS notice_reads_user_idx ON notice_reads (user_id)
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
    // "Already holds every key", never a length comparison: see `20260309`.
    if (wanted.every((key) => stored.includes(key))) continue;

    const merged = [...new Set([...stored, ...wanted])].sort();
    await knex('roles')
      .where({ id: role.id, tenant_id: role.tenant_id })
      .update({ permissions: JSON.stringify(merged) });
  }
}

export async function down(knex: Knex): Promise<void> {
  // The tables only. Revoking the keys is not the inverse of granting them: an
  // administrator may since have handed them to other roles through the grid.
  await knex.raw('DROP TABLE IF EXISTS notice_reads');
  await knex.raw('DROP TABLE IF EXISTS notice_audiences');
  await knex.raw('DROP TABLE IF EXISTS notices');
}
