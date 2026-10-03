/**
 * The Chatroom (1.3 Phase 6, migration #5).
 *
 * Three tables and one grant, all additive and safe to run twice.
 *
 * **Tables.** `chat_rooms`, `chat_members` and `chat_messages`. Tasks, pins and
 * tombstones are columns on the message, not tables of their own, and a task's
 * "seen by" is worked out from each member's `last_read_seq`, so there is no
 * receipt table either. Every column that names a person is `TEXT REFERENCES
 * users(id)`: users are soft-deleted and restorable, never removed, so the
 * reference cannot dangle. A room's `last_seq` is bumped under a row lock in
 * the same transaction that inserts the message, which keeps each room's
 * `seq` gap-free; the author's own `last_read_seq` moves with it, so
 * "unread" is `last_seq - last_read_seq` with no COUNT query.
 *
 * A deleted message keeps its body in the table for the record, and the Master
 * never serves it. Messages are not in the Recycle Bin and are never purged.
 *
 * **The grant.** All six `chat.*` keys go to every role of the `admin` and
 * `server_master` tiers, and `chat.use` and `chat.shareRecords` to every role of
 * the `office` and `management` tiers, so the Chatroom works out of the box for
 * the people the owner asked it for. Union, never replace, and idempotent: the
 * same shape and reasoning as `20260309000000_new_module_permission_grant.ts`
 * and `20261004000000_report_indexes_and_grants.ts` (no tenant filter and no
 * `deleted_at` filter, so a restored role comes back holding what its siblings
 * hold). `server_master` matches nothing on a database that has no such role
 * yet. An administrator can still untick any key on any role.
 *
 * The key lists and tier names are inline, never read from `@orderbook/shared`:
 * a migration must not change meaning when a shared constant does.
 */

import type { Knex } from 'knex';

const ALL_KEYS = [
  'chat.use',
  'chat.directMessages',
  'chat.shareRecords',
  'chat.tasks',
  'chat.createGroups',
  'chat.manage',
] as const;

const GRANTS: ReadonlyArray<{ tiers: readonly string[]; keys: readonly string[] }> = [
  { tiers: ['admin', 'server_master'], keys: ALL_KEYS },
  { tiers: ['office', 'management'], keys: ['chat.use', 'chat.shareRecords'] },
];

interface RoleRow {
  id: string;
  tenant_id: string;
  permissions: unknown;
}

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS chat_rooms (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CONSTRAINT chat_rooms_kind CHECK (kind IN ('group', 'direct', 'announcement')),
      name TEXT NULL CONSTRAINT chat_rooms_name CHECK (kind = 'direct' OR char_length(btrim(name)) BETWEEN 1 AND 60),
      description TEXT NULL CONSTRAINT chat_rooms_description CHECK (description IS NULL OR char_length(description) <= 280),
      direct_key TEXT NULL CONSTRAINT chat_rooms_direct_key CHECK ((kind = 'direct') = (direct_key IS NOT NULL)),
      last_seq BIGINT NOT NULL DEFAULT 0,
      last_message_at TIMESTAMPTZ NULL,
      created_by TEXT NULL REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      archived_at TIMESTAMPTZ NULL,
      archived_by TEXT NULL REFERENCES users(id)
    )
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS chat_rooms_direct_key_uq
      ON chat_rooms (tenant_id, direct_key) WHERE direct_key IS NOT NULL
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS chat_rooms_group_name_uq
      ON chat_rooms (tenant_id, lower(name)) WHERE kind <> 'direct' AND archived_at IS NULL
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS chat_rooms_recent_idx ON chat_rooms (tenant_id, last_message_at DESC)
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS chat_members (
      room_id UUID NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id),
      role TEXT NOT NULL DEFAULT 'member' CONSTRAINT chat_members_role CHECK (role IN ('admin', 'member')),
      muted BOOLEAN NOT NULL DEFAULT false,
      last_read_seq BIGINT NOT NULL DEFAULT 0,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (room_id, user_id)
    )
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS chat_members_user_idx ON chat_members (tenant_id, user_id)
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY CONSTRAINT chat_messages_id CHECK (id ~ '^CM[0-9]{10}$'),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      room_id UUID NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
      seq BIGINT NOT NULL,
      author_id TEXT NULL REFERENCES users(id),
      kind TEXT NOT NULL CONSTRAINT chat_messages_kind CHECK (kind IN ('text', 'task', 'system')),
      body TEXT NOT NULL DEFAULT '' CONSTRAINT chat_messages_body CHECK (char_length(body) <= 4000),
      refs JSONB NOT NULL DEFAULT '[]'::jsonb,
      mentions JSONB NOT NULL DEFAULT '[]'::jsonb,
      system JSONB NULL,
      client_id TEXT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      edited_at TIMESTAMPTZ NULL,
      deleted_at TIMESTAMPTZ NULL,
      deleted_by TEXT NULL REFERENCES users(id),
      pinned_at TIMESTAMPTZ NULL,
      pinned_by TEXT NULL REFERENCES users(id),
      task_assignees JSONB NULL,
      task_due_on DATE NULL,
      task_done_at TIMESTAMPTZ NULL,
      task_done_by TEXT NULL REFERENCES users(id),
      CONSTRAINT chat_messages_task_only CHECK (kind = 'task' OR task_assignees IS NULL),
      CONSTRAINT chat_messages_room_seq_uq UNIQUE (room_id, seq)
    )
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_client_uq
      ON chat_messages (tenant_id, client_id) WHERE client_id IS NOT NULL
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS chat_messages_room_seq_idx ON chat_messages (room_id, seq DESC)
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS chat_messages_pinned_idx ON chat_messages (room_id) WHERE pinned_at IS NOT NULL
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS chat_messages_open_tasks_idx
      ON chat_messages (tenant_id) WHERE kind = 'task' AND task_done_at IS NULL AND deleted_at IS NULL
  `);

  for (const grant of GRANTS) {
    const roles = await knex('roles')
      .whereIn('tier', [...grant.tiers])
      .select<RoleRow[]>('id', 'tenant_id', 'permissions');

    for (const role of roles) {
      const stored = Array.isArray(role.permissions)
        ? role.permissions.filter((entry): entry is string => typeof entry === 'string')
        : [];

      // "Already holds every key", never a length comparison: see `20260309`.
      if (grant.keys.every((key) => stored.includes(key))) continue;

      const merged = [...new Set([...stored, ...grant.keys])].sort();
      await knex('roles')
        .where({ id: role.id, tenant_id: role.tenant_id })
        .update({ permissions: JSON.stringify(merged) });
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  // The tables only. Revoking the keys is not the inverse of granting them: an
  // administrator may since have handed them to other roles through the grid.
  await knex.raw('DROP TABLE IF EXISTS chat_messages');
  await knex.raw('DROP TABLE IF EXISTS chat_members');
  await knex.raw('DROP TABLE IF EXISTS chat_rooms');
}
