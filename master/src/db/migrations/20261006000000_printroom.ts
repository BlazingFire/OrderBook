/**
 * The Printroom (1.3 Phase 7, migration #6).
 *
 * Two tables and one grant, all additive and safe to run twice.
 *
 * **`print_stations`.** One row per PC that has registered as a station: the
 * Master PC itself (`station_key = 'master'`) or an Office Panel
 * (`'panel:<panel id>'`). The key is always derived on the Master from the
 * connection, never read from a body. `last_seen_at` drives the "online" dot a
 * sender sees (a station is online when it was heard from in the last 90 s).
 *
 * **`print_jobs`.** One row per note sent. `payload` is the frozen note the
 * Master built at send time (so the printer PC never depends on its own
 * snapshot or party scope); it is set to NULL 30 days after a job is printed or
 * cancelled, while who sent, printed or cancelled it and when stay for good.
 * `status` is `queued`, `printing` (a station holds it), `printed` or
 * `cancelled`. The station's claim is held by its connection: `claim_socket` is
 * that connection's id, released when it drops and cleared at Master boot, and a
 * claim older than ten minutes may be taken by another station. Every column
 * that names a person is `TEXT REFERENCES users(id)`: users are soft-deleted and
 * restorable, never removed, so the reference cannot dangle. `printed_by` and
 * `claimed_by` are nullable because an auto-print station can run with nobody
 * signed in; the station column then says which PC it was.
 *
 * `UNIQUE (tenant_id, sender_id, request_id)` is what makes a retried send
 * return the same job instead of a second sheet of paper.
 *
 * **The grant.** `print.send` and `print.station` go to every role of the
 * `admin` and `server_master` tiers; management and office roles get them when
 * an administrator ticks them. Union, never replace, and idempotent: the same
 * shape and reasoning as `20261005000000_chatroom.ts` (no tenant filter and no
 * `deleted_at` filter, so a restored role comes back holding what its siblings
 * hold). `server_master` matches nothing on a database that has no such role yet.
 *
 * The key lists and tier names are inline, never read from `@orderbook/shared`:
 * a migration must not change meaning when a shared constant does.
 */

import type { Knex } from 'knex';

const KEYS = ['print.send', 'print.station'] as const;
const TIERS = ['admin', 'server_master'] as const;

interface RoleRow {
  id: string;
  tenant_id: string;
  permissions: unknown;
}

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS print_stations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      station_key TEXT NOT NULL
        CONSTRAINT print_stations_key CHECK (station_key = 'master' OR station_key ~ '^panel:[0-9A-Fa-f-]{36}$'),
      display_name TEXT NOT NULL
        CONSTRAINT print_stations_name CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 60),
      printer_name TEXT NULL
        CONSTRAINT print_stations_printer CHECK (printer_name IS NULL OR char_length(printer_name) <= 200),
      auto_print BOOLEAN NOT NULL DEFAULT false,
      last_seen_at TIMESTAMPTZ NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT print_stations_key_uq UNIQUE (tenant_id, station_key)
    )
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS print_jobs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL
        CONSTRAINT print_jobs_request_id CHECK (request_id ~ '^[0-9a-f]{32}$'),
      kind TEXT NOT NULL CONSTRAINT print_jobs_kind CHECK (kind IN ('filling', 'dispatch')),
      source_type TEXT NOT NULL CONSTRAINT print_jobs_source CHECK (source_type IN ('lead', 'order')),
      source_id TEXT NOT NULL,
      source_number TEXT NULL,
      party_name TEXT NOT NULL,
      payload JSONB NULL,
      copies SMALLINT NOT NULL CONSTRAINT print_jobs_copies CHECK (copies BETWEEN 1 AND 50),
      note TEXT NULL CONSTRAINT print_jobs_note CHECK (note IS NULL OR char_length(note) <= 200),
      target_station_id UUID NULL REFERENCES print_stations(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'queued'
        CONSTRAINT print_jobs_status CHECK (status IN ('queued', 'printing', 'printed', 'cancelled')),
      sender_id TEXT NOT NULL REFERENCES users(id),
      requested_from TEXT NULL,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      claimed_by TEXT NULL REFERENCES users(id),
      claimed_station_id UUID NULL REFERENCES print_stations(id) ON DELETE SET NULL,
      claimed_at TIMESTAMPTZ NULL,
      claim_socket TEXT NULL,
      printed_by TEXT NULL REFERENCES users(id),
      printed_station_id UUID NULL REFERENCES print_stations(id) ON DELETE SET NULL,
      printed_at TIMESTAMPTZ NULL,
      printer_name TEXT NULL,
      cancelled_by TEXT NULL REFERENCES users(id),
      cancelled_at TIMESTAMPTZ NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT print_jobs_request_uq UNIQUE (tenant_id, sender_id, request_id)
    )
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS print_jobs_queue_idx
      ON print_jobs (tenant_id, status, requested_at DESC, id DESC)
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS print_jobs_sender_idx
      ON print_jobs (tenant_id, sender_id, requested_at DESC)
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS print_jobs_claim_idx
      ON print_jobs (claim_socket) WHERE claim_socket IS NOT NULL
  `);

  const roles = await knex('roles').whereIn('tier', [...TIERS]).select<RoleRow[]>('id', 'tenant_id', 'permissions');
  for (const role of roles) {
    const stored = Array.isArray(role.permissions)
      ? role.permissions.filter((entry): entry is string => typeof entry === 'string')
      : [];

    // "Already holds every key", never a length comparison: see `20260309`.
    if (KEYS.every((key) => stored.includes(key))) continue;

    const merged = [...new Set([...stored, ...KEYS])].sort();
    await knex('roles')
      .where({ id: role.id, tenant_id: role.tenant_id })
      .update({ permissions: JSON.stringify(merged) });
  }
}

export async function down(knex: Knex): Promise<void> {
  // The tables only. Revoking the keys is not the inverse of granting them: an
  // administrator may since have handed them to other roles through the grid.
  await knex.raw('DROP TABLE IF EXISTS print_jobs');
  await knex.raw('DROP TABLE IF EXISTS print_stations');
}
