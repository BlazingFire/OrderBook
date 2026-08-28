/**
 * Two tables: the company's settings, and the recoverable password vault the
 * first of them switches on.
 *
 * **Neither is seeded and no permission is granted here.** An absent `settings`
 * row means the value declared in `shared/src/domain/settings.ts`, so an
 * installation that runs this migration behaves exactly as it did the minute
 * before — including `security.passwordRevealEnabled`, which is `false` by
 * declaration and therefore leaves the vault permanently empty until an
 * administrator deliberately turns it on.
 *
 * `settings` is a row per key, the shape `option_lists` already establishes.
 * Typed columns on `master_config` were rejected because a migration per toggle
 * is what makes people stop adding toggles; a single JSONB blob was rejected
 * because it gives no per-key audit, no per-key secret handling, and a
 * read-modify-write race on every save. `key` and `value` are quoted: both are
 * reserved-ish words that read badly unquoted in raw SQL.
 *
 * There is no `version`/`hlc`/`field_hlc` on either table. Settings never sync —
 * `settings` is deliberately absent from `sync.service.ts`'s `COLUMN_MAP` — and
 * the vault must never reach an Office Panel at all.
 *
 * `user_password_vault` is a separate table rather than a column on `users` for
 * two reasons that are both about blast radius: `USER_COLUMNS` is one `u.*`
 * regression away from carrying a new column into every user list (the drift
 * `credential-invariants.test.ts` exists to catch), and a named table can be
 * excluded from the backup scan and truncated wholesale.
 *
 * `user_id` carries **no foreign key**, matching `party_access.user_id` and
 * `users.role_id`: users are soft-deleted and restorable, and a restored person
 * must come back with their vault row intact.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE settings (
      tenant_id   UUID NOT NULL REFERENCES tenants(id),
      "key"       TEXT NOT NULL,
      "value"     JSONB,
      is_secret   BOOLEAN NOT NULL DEFAULT false,
      key_version INT NOT NULL DEFAULT 1,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by  TEXT,
      PRIMARY KEY (tenant_id, "key")
    )
  `);

  await knex.raw(`
    CREATE TABLE user_password_vault (
      tenant_id              UUID NOT NULL REFERENCES tenants(id),
      user_id                TEXT NOT NULL,
      key_version            INT  NOT NULL DEFAULT 1,
      sealed                 JSONB NOT NULL,
      credential_fingerprint TEXT NOT NULL,
      updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by             TEXT,
      PRIMARY KEY (tenant_id, user_id)
    )
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS user_password_vault`);
  await knex.raw(`DROP TABLE IF EXISTS settings`);
}
