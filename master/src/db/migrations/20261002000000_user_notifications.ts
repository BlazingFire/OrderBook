/**
 * Per-user notifications, the bell on both panels (1.3 batch, migration #2).
 *
 * One row is one notice for one person. `kind` names the message that renders
 * it (`notification.<kind>`) and `params` fills it in; `link` says where
 * opening it goes. `dedupe_key` stops the same unread notice piling up (a
 * panel that keeps dropping is one notice until somebody reads it), which the
 * partial unique index enforces. Read notices are kept, then pruned by the
 * notification service, not by this migration.
 *
 * `user_id` is TEXT because `users.id` is (`20260303000000_roles_and_users`).
 * Deleting a user takes their notices with them.
 *
 * Additive and safe to run twice.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS user_notifications (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CONSTRAINT user_notifications_kind_shape CHECK (kind ~ '^[a-z]+[.][a-zA-Z]+$'),
      params jsonb NOT NULL DEFAULT '{}'::jsonb,
      link jsonb NULL,
      dedupe_key TEXT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      read_at timestamptz NULL
    )
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_user_notifications_user_created
      ON user_notifications (tenant_id, user_id, created_at DESC)
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_user_notifications_unread
      ON user_notifications (tenant_id, user_id)
      WHERE read_at IS NULL
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_user_notifications_unread_dedupe
      ON user_notifications (tenant_id, user_id, dedupe_key)
      WHERE dedupe_key IS NOT NULL AND read_at IS NULL
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP TABLE IF EXISTS user_notifications');
}
