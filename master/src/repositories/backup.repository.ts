/**
 * Raw, generic table access for the storage export/import format
 * (`docs/7-STORAGE-BACKUP-RESTORE.md` §4). Deliberately below the usual
 * repository layer's contract: every other repository maps a table's rows to
 * a domain entity, but a backup tool exists to move rows it does not
 * interpret, so it reads and writes `Record<string, unknown>` for whatever
 * tables happen to exist right now — found via `information_schema`, never a
 * hand-maintained list (`HANDOFF.md`: "ask information_schema instead").
 *
 * Two Postgres-specific choices carry this file's correctness:
 *
 *  - **`session_replication_role = 'replica'`** during the load disables every
 *    trigger on the connection, including foreign-key enforcement and the
 *    `activity_log` hash-chain trigger. Without it, restoring rows would need
 *    a topological insert order across every table's foreign keys — brittle,
 *    and re-derived by hand exactly where `HANDOFF.md` already warns not to.
 *    It also stops `activity_log_chain_trg` from recomputing a *new* chain
 *    over the restored rows, which would silently discard the original,
 *    already-verified hashes the export carried.
 *  - **A single transaction around truncate + load + verify.** If the hash
 *    chain fails to verify, or anything else throws, Postgres rolls the whole
 *    transaction back and the live schema is exactly as it was before the
 *    restore was attempted — the "temp location, verify completely, then swap
 *    in" guarantee (§5.3), implemented as a transaction rollback instead of a
 *    filesystem copy-then-swap, since the live data is a database, not files.
 *
 * `session_replication_role` requires a superuser-equivalent role. The
 * Master's own embedded-Postgres cluster bootstraps its `orderbook` role as
 * the cluster owner, which has it; an external cluster used via `DATABASE_URL`
 * (`HANDOFF.md`'s owner-PC setup) needs a role with the same privilege for
 * restore to work. Not yet surfaced as a preflight check — see `HANDOFF.md`.
 */

import type { Knex } from 'knex';

import { db } from '../db/knex.js';

type Runner = Knex | Knex.Transaction;

const SYSTEM_TABLES = new Set(['knex_migrations', 'knex_migrations_lock']);

export async function listUserTables(runner: Runner = db()): Promise<string[]> {
  const { rows } = await runner.raw<{ rows: Array<{ table_name: string }> }>(`
    SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name
  `);
  return rows.map((row) => row.table_name).filter((name) => !SYSTEM_TABLES.has(name));
}

/** Tables carrying a `tenant_id` column — the unit a `selected` export/restore filters by. */
export async function tenantScopedTables(runner: Runner = db()): Promise<Set<string>> {
  const { rows } = await runner.raw<{ rows: Array<{ table_name: string }> }>(`
    SELECT DISTINCT table_name FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name = 'tenant_id'
  `);
  return new Set(rows.map((row) => row.table_name));
}

export async function dumpTable(
  table: string,
  tenantIds: string[] | null,
  isTenantScoped: boolean,
  runner: Runner = db(),
): Promise<Record<string, unknown>[]> {
  let query = runner(table).select('*');
  if (tenantIds) {
    if (isTenantScoped) query = query.whereIn('tenant_id', tenantIds);
    else if (table === 'tenants') query = query.whereIn('id', tenantIds);
  }
  return query;
}

/**
 * Replace the content of every listed table with the payload's rows, inside
 * the caller's transaction. `tenantIds === null` means a whole restore
 * (truncate everything); otherwise only the named tenants' rows are replaced,
 * everything else in the live database is left untouched.
 */
export async function loadTables(
  trx: Knex.Transaction,
  tables: readonly string[],
  tenantScoped: ReadonlySet<string>,
  payload: Readonly<Record<string, Record<string, unknown>[]>>,
  tenantIds: string[] | null,
): Promise<void> {
  await trx.raw(`SET session_replication_role = 'replica'`);
  try {
    if (tenantIds === null) {
      const identifiers = tables.map((table) => `"${table}"`).join(', ');
      if (identifiers) await trx.raw(`TRUNCATE TABLE ${identifiers} RESTART IDENTITY CASCADE`);
    } else {
      for (const table of tables) {
        if (tenantScoped.has(table)) {
          await trx(table).whereIn('tenant_id', tenantIds).delete();
        } else if (table === 'tenants') {
          await trx(table).whereIn('id', tenantIds).delete();
        }
        // A table that is neither tenant-scoped nor `tenants` itself has no
        // selected-scope meaning (there is nothing to select it *by*), so a
        // `selected` restore leaves it untouched — matching the export side,
        // which only ever dumps such a table in full.
      }
    }

    for (const table of tables) {
      const rows = payload[table];
      if (!rows || rows.length === 0) continue;

      const CHUNK = 500;
      for (let i = 0; i < rows.length; i += CHUNK) {
        await trx.batchInsert(table, rows.slice(i, i + CHUNK).map(stringifyJsonColumns), CHUNK);
      }
    }

    await resyncSequences(trx, tables);
  } finally {
    // Unquoted: `session_replication_role` only accepts 'origin'/'replica'/'local'
    // as a string literal — `'DEFAULT'` is not one of them and errors. Resetting
    // to a GUC's own default is the one case Postgres spells as a bare keyword.
    await trx.raw(`SET session_replication_role = DEFAULT`);
  }
}

/**
 * `dumpTable` reads JSONB columns back as plain JS objects/arrays (`pg`
 * parses them on the way out), and the export round-trips the whole payload
 * through `JSON.stringify`/`JSON.parse`, so every value reaching here is
 * already a JSON-safe primitive, plain object, or plain array — never a
 * `Date`. `batchInsert` hands each value straight to `pg` as a query
 * parameter, and `pg` serializes a plain object to JSON but serializes a
 * plain array as a *Postgres array literal* — the right thing for a real
 * `text[]` column, and invalid syntax for the JSONB columns this schema uses
 * for array-shaped data (`roles.permissions`, `custom_fields`). Nothing in
 * this file has column-type information (`loadTables` is generic over
 * whatever `information_schema` reports), so every object/array value is
 * stringified rather than only the ones known to need it.
 */
function stringifyJsonColumns(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = value !== null && typeof value === 'object' ? JSON.stringify(value) : value;
  }
  return out;
}

/**
 * Wind every sequence past the rows the load just reinstated.
 *
 * Restored rows carry their original keys — `dumpTable` selects `*` — and an
 * INSERT that supplies a value for a serial column never calls `nextval`. So the
 * `RESTART IDENTITY` above leaves `activity_log_id_seq` at 1 with five thousand
 * restored rows sitting on top of it, and the next audited write dies on the
 * primary key. Because `recordActivity` is required to run inside the caller's
 * transaction, that duplicate key aborts the business write with it, and
 * `nextval` climbs one number per failed attempt — so a restore that reported
 * success would break every write for as many attempts as it restored rows.
 *
 * Which sequences exist is asked of the catalogue rather than listed here, the
 * same choice the table list makes. The two display-code sequences are the
 * exception, and they fail from the other direction: `party_code`/`product_code`
 * are TEXT assembled from `nextval` in their repositories, so no column owns the
 * sequence, nothing in the catalogue connects it to the values it produced, and
 * `RESTART IDENTITY` does not touch it either. Restoring onto a fresh install
 * would hand out `P-0001` a second time and collide on the code's unique index.
 */
async function resyncSequences(trx: Knex.Transaction, tables: readonly string[]): Promise<void> {
  await trx.raw(`
    DO $$
    DECLARE
      target record;
      resume_at bigint;
    BEGIN
      FOR target IN
        SELECT table_name, column_name, sequence_name FROM (
          SELECT table_name, column_name,
                 pg_get_serial_sequence(quote_ident(table_name), column_name) AS sequence_name
            FROM information_schema.columns
           WHERE table_schema = 'public'
             AND (column_default LIKE 'nextval(%' OR is_identity = 'YES')
        ) serials WHERE sequence_name IS NOT NULL
      LOOP
        EXECUTE format('SELECT COALESCE(max(%I), 0) + 1 FROM %I', target.column_name, target.table_name)
           INTO resume_at;
        PERFORM setval(target.sequence_name::regclass, resume_at, false);
      END LOOP;
    END $$;
  `);

  // Read back off the codes themselves: the sequence only ever supplied the
  // digits, and the restored rows are the only record of how far it had got.
  if (tables.includes('parties')) {
    await trx.raw(
      `SELECT setval('party_code_seq',
                     COALESCE((SELECT max(substring(party_code from '[0-9]+$')::bigint) FROM parties), 0) + 1,
                     false)`,
    );
  }
  if (tables.includes('products')) {
    await trx.raw(
      `SELECT setval('product_code_seq',
                     COALESCE((SELECT max(substring(product_code from '[0-9]+$')::bigint) FROM products), 0) + 1,
                     false)`,
    );
  }
}

/**
 * Recomputes every restored tenant's hash chain from the rows now on disk and
 * compares it against the stored `hash`/`prev_hash` — the chain the export
 * claimed was "intact and re-verifiable" (§4.1) is not trusted, it is checked.
 * Any pre-chain row (`hash = 'pre-chain'`, from before chaining existed,
 * `20260303000000_roles_and_users.ts`) is skipped, exactly as it was never
 * claimed to verify at export time either.
 *
 * **Recomputed in SQL, by the same `activity_log_row_hash` the trigger uses.**
 * The digest's last component is `COALESCE(details::text, '')` — Postgres's own
 * JSONB rendering, which puts a space after every `:` and `,` and normalises key
 * order. `JSON.stringify` produces neither, so a Node-side digest never matched
 * a real row, and since every `recordActivity` call passes a non-empty
 * `details`, the first restored entry failed. That threw `hash_chain_invalid`
 * inside the restore transaction and rolled the whole thing back, so restoring
 * any backup of a database that had ever logged anything was impossible — and
 * the failure read as "your backup has been tampered with".
 * `activity-log.repository.ts#verifyChain` re-walks the chain in SQL for this
 * same reason; this is the second caller, not a new technique.
 */
export async function verifyActivityLogChain(trx: Knex.Transaction, tenantIds: string[]): Promise<boolean> {
  if (tenantIds.length === 0) return true;

  const { rows } = await trx.raw<{
    rows: Array<{ tenant_id: string; prev_hash: string; hash: string; recomputed: string }>;
  }>(
    `SELECT tenant_id, prev_hash, hash,
            activity_log_row_hash(prev_hash, sequence, entity_type, entity_id, action, actor_type, actor_id, details) AS recomputed
       FROM activity_log
      WHERE tenant_id = ANY(?) AND hash <> 'pre-chain'
      ORDER BY tenant_id, sequence ASC`,
    [tenantIds],
  );

  const expectedPrev = new Map<string, string>();

  for (const row of rows) {
    if (row.hash !== row.recomputed) return false;

    // Seeded from the row's own `prev_hash` rather than from genesis: a tenant's
    // first *chained* row may follow a block of pre-chain rows, so it legitimately
    // does not link back to sixty-four zeroes.
    const priorHash = expectedPrev.get(row.tenant_id);
    if (priorHash !== undefined && row.prev_hash !== priorHash) return false;

    expectedPrev.set(row.tenant_id, row.hash);
  }

  return true;
}

/**
 * Every restored panel row is a *reference*, not a trusted credential (§4.1,
 * §6.1 adapted: this codebase pins no fingerprint, but the same principle
 * applies to the shared secret it uses instead). Re-pairing always issues a
 * fresh secret, so the restored value can never be a live one.
 */
export async function revokeAllOfficePanels(trx: Knex.Transaction): Promise<void> {
  const { randomBytes } = await import('node:crypto');
  await trx('office_panels').update({
    status: 'revoked',
    secret_hash: `restored$${randomBytes(32).toString('hex')}`,
  });
}

export async function regeneratePairingPasswordHash(trx: Knex.Transaction, hash: string): Promise<void> {
  await trx('master_config').update({ pairing_password_hash: hash });
}

export async function listTenantIds(runner: Runner = db()): Promise<string[]> {
  const rows = await runner('tenants').select<{ id: string }[]>('id');
  return rows.map((row) => row.id);
}
