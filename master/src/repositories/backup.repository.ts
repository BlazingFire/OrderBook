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

/**
 * Tables an export must never carry and a restore must never write.
 *
 * The two Knex bookkeeping tables are here because a restore replays into a
 * schema whose migration history is its own. `user_password_vault` is here for
 * a sharper reason: it holds passwords that are only encrypted, and the key
 * that opens them lives in `dataDir/secrets/`, deliberately outside every
 * backup. Excluding the table is what makes a stolen `.obbackup` worth nothing
 * — and it must never be removed from this set to "fix" a restore that comes
 * back with an empty vault. An empty vault after a restore is correct: those
 * rows are keyed to user ids that may now mean somebody else, and
 * `backup-restore.service.ts` clears the live table for exactly that reason.
 */
const EXCLUDED_TABLES = new Set([
  'knex_migrations',
  'knex_migrations_lock',
  'user_password_vault',
  // Local per-installation HLC state, seeded unconditionally by migration and
  // self-healing if missing (`identity.repository.ts#lockClock`) — not
  // portable data. Carrying it in an export means every restore onto a Master
  // that already has its own row (which every Master does, from the moment
  // migrations finish) hits a unique-violation on `id = 1` and rolls the
  // whole restore back. Same reasoning as `user_password_vault`: excluded
  // rather than "fixed", because the live row is correct for *this*
  // installation and a restored one would not be.
  'master_clock',
  // A person's notices are about this installation's own events (a panel that
  // dropped, a print that finished) and point at ids a restore may reuse for
  // other records. Like the vault, not carried across.
  'user_notifications',
]);

/**
 * Tenant data that has no `tenant_id` column of its own — reached only through
 * one foreign key into a table that does. `tenantScopedTables()` (a literal
 * `information_schema` column scan) cannot see these, so a `selected` export
 * dumped them in full across every tenant, and a `selected` restore left them
 * untouched rather than replaced. Both `dumpTable` and `loadTables` special-case
 * this small map explicitly.
 */
const TRANSITIVELY_SCOPED: Record<string, { via: string; foreignKey: string }> = {
  pipeline_stages: { via: 'pipelines', foreignKey: 'pipeline_id' },
  todo_marks: { via: 'todos', foreignKey: 'todo_id' },
};

export async function listUserTables(runner: Runner = db()): Promise<string[]> {
  const { rows } = await runner.raw<{ rows: Array<{ table_name: string }> }>(`
    SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name
  `);
  return rows.map((row) => row.table_name).filter((name) => !EXCLUDED_TABLES.has(name));
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
    if (isTenantScoped) {
      query = query.whereIn('tenant_id', tenantIds);
    } else if (table === 'tenants') {
      query = query.whereIn('id', tenantIds);
    } else {
      const transitive = TRANSITIVELY_SCOPED[table];
      if (transitive) {
        query = query.whereIn(
          transitive.foreignKey,
          runner(transitive.via).select('id').whereIn('tenant_id', tenantIds),
        );
      }
    }
  }
  const rows: Record<string, unknown>[] = await query;
  // `master_proof_key` stays out of every export: it lets whoever holds it pass
  // as this Master to its panels (`proveMaster`), and a restored panel is
  // revoked and re-paired anyway (`revokeAllOfficePanels`).
  if (table === 'office_panels') for (const row of rows) delete row.master_proof_key;
  return rows;
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
      await truncateTables(trx, tables);
    } else {
      for (const table of tables) {
        if (tenantScoped.has(table)) {
          await trx(table).whereIn('tenant_id', tenantIds).delete();
        } else if (table === 'tenants') {
          await trx(table).whereIn('id', tenantIds).delete();
        } else {
          const transitive = TRANSITIVELY_SCOPED[table];
          if (transitive) {
            await trx(table)
              .whereIn(
                transitive.foreignKey,
                trx(transitive.via).select('id').whereIn('tenant_id', tenantIds),
              )
              .delete();
          }
          // Anything else is neither tenant-scoped, `tenants` itself, nor
          // transitively scoped, so it has no selected-scope meaning (there
          // is nothing to select it *by*) — a `selected` restore leaves it
          // untouched, matching the export side, which only ever dumps such
          // a table in full.
        }
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
 * same choice the table list makes. The party display-code sequence is the
 * exception, and it fails from the other direction: `party_code` is TEXT
 * assembled from `nextval` in its repository, so no column owns the sequence,
 * nothing in the catalogue connects it to the values it produced, and
 * `RESTART IDENTITY` does not touch it either. Restoring onto a fresh install
 * would hand out `P-0001` a second time and collide on the code's unique
 * index. (Product codes are typed, never generated, so there is no product
 * sequence to resync.)
 */
export async function resyncSequences(trx: Knex.Transaction, tables: readonly string[]): Promise<void> {
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
    master_proof_key: null,
  });
}

export async function regeneratePairingPasswordHash(trx: Knex.Transaction, hash: string): Promise<void> {
  await trx('master_config').update({ pairing_password_hash: hash });
}

export async function listTenantIds(runner: Runner = db()): Promise<string[]> {
  const rows = await runner('tenants').select<{ id: string }[]>('id');
  return rows.map((row) => row.id);
}

// --- Backup all: the plain-zip archive (format 2) ---------------------------
//
// The archive moves every row as Postgres renders it, `row_to_json(t)::text`,
// and loads it back with `json_populate_recordset`. Postgres does both ends,
// so timestamps keep their microseconds, numerics their digits and JSONB its
// shape, and no row ever becomes a JavaScript object on the way through: the
// low-RAM PCs this runs on hold one page of text at a time.

/** The excluded tables and every Knex bookkeeping table: never read into an archive, never written from one. */
export function isExcludedTable(table: string): boolean {
  return EXCLUDED_TABLES.has(table) || table.startsWith('knex_');
}

/** A table name as a quoted identifier, refusing anything that is not a plain lower-case name. */
function quotedTable(table: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(table)) throw new Error(`Not a table name: ${table}`);
  return `"${table}"`;
}

function assertArchivable(table: string): string {
  if (isExcludedTable(table)) throw new Error(`Table ${table} never travels in a backup`);
  return quotedTable(table);
}

/** A primary-key column and its type as Postgres spells it, for casting a keyset bound back. */
export interface KeyColumn {
  name: string;
  type: string;
}

/** The table's primary-key columns in key order, or `[]` when it has none. */
export async function primaryKeyColumns(table: string, runner: Runner = db()): Promise<KeyColumn[]> {
  const { rows } = await runner.raw<{ rows: KeyColumn[] }>(
    `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = ?::regclass AND i.indisprimary
      ORDER BY array_position(i.indkey::int2[], a.attnum)`,
    [`public.${quotedTable(table)}`],
  );
  return rows;
}

/**
 * Every row of `table` as one JSON text, handed to `onRow` in primary-key
 * order, `pageSize` rows per query.
 *
 * Keyset paging rather than OFFSET, so the last page costs what the first
 * did; the bound is read back as text and cast to the key's own type, so a
 * timestamp key keeps its microseconds. A table without a primary key pages
 * by `ctid`, which is stable inside the REPEATABLE READ snapshot the export
 * runs in. Resolves the number of rows.
 */
export async function streamTableNdjson(
  table: string,
  onRow: (json: string) => void | Promise<void>,
  options: { runner?: Runner; pageSize?: number } = {},
): Promise<number> {
  const runner = options.runner ?? db();
  const pageSize = options.pageSize ?? 2000;
  const quoted = assertArchivable(table);

  const keys = await primaryKeyColumns(table, runner);
  const columns = keys.length > 0 ? keys : [{ name: 'ctid', type: 'tid' }];
  const keyList = columns.map((key) => `t."${key.name}"`).join(', ');
  const bound = columns.map((key) => `CAST(? AS ${key.type})`).join(', ');
  const keyTexts = columns.map((key, index) => `t."${key.name}"::text AS k${index}`).join(', ');

  let after: string[] | null = null;
  let count = 0;
  for (;;) {
    const where = after ? `WHERE (${keyList}) > (${bound})` : '';
    const page: { rows: Array<Record<string, string>> } = await runner.raw(
      `SELECT row_to_json(t)::text AS j, ${keyTexts} FROM ${quoted} t ${where} ORDER BY ${keyList} LIMIT ?`,
      [...(after ?? []), pageSize],
    );
    for (const row of page.rows) await onRow(row.j!);
    count += page.rows.length;
    if (page.rows.length < pageSize) return count;
    const last = page.rows[page.rows.length - 1]!;
    after = columns.map((_key, index) => last[`k${index}`]!);
  }
}

/**
 * The columns a load may write: every column of the live table that is not
 * generated, narrowed to `among` when given. An archive made at an older
 * schema level names fewer columns than the table now has; the ones it lacks
 * are left to their defaults instead of being written as null.
 */
export async function insertableColumns(
  table: string,
  runner: Runner = db(),
  among?: Iterable<string>,
): Promise<string[]> {
  const { rows } = await runner.raw<{ rows: Array<{ column_name: string }> }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ? AND is_generated = 'NEVER'
      ORDER BY ordinal_position`,
    [table],
  );
  const present = among ? new Set(among) : null;
  return rows.map((row) => row.column_name).filter((name) => !present || present.has(name));
}

/**
 * Insert a batch of JSON rows, each the text of one `row_to_json`, into
 * `table` in the caller's transaction. `OVERRIDING SYSTEM VALUE` keeps the
 * original ids of identity columns; the caller resyncs sequences afterwards.
 */
export async function insertJsonBatch(
  trx: Knex.Transaction,
  table: string,
  columns: readonly string[],
  rows: readonly string[],
): Promise<void> {
  const quoted = assertArchivable(table);
  if (rows.length === 0 || columns.length === 0) return;
  const list = columns.map((column) => `"${column.replace(/"/g, '""')}"`).join(', ');
  await trx.raw(
    `INSERT INTO ${quoted} (${list}) OVERRIDING SYSTEM VALUE
     SELECT ${list} FROM json_populate_recordset(NULL::${quoted}, ?::json)`,
    [`[${rows.join(',')}]`],
  );
}

/** Empty every listed table and restart its identities, in the caller's transaction. */
export async function truncateTables(trx: Knex.Transaction, tables: readonly string[]): Promise<void> {
  const identifiers = tables.map(assertArchivable).join(', ');
  if (identifiers) await trx.raw(`TRUNCATE TABLE ${identifiers} RESTART IDENTITY CASCADE`);
}

/** The migrations this database has run, in the order it ran them: the schema level of its rows. */
export async function appliedMigrationNames(runner: Runner = db()): Promise<string[]> {
  const rows = await runner('knex_migrations').orderBy('id').select<Array<{ name: string }>>('name');
  return rows.map((row) => row.name);
}

/**
 * Sealed values that travel in the rows but cannot be opened on another PC,
 * because the key that seals them (`secrets/vault.key`) never leaves this one:
 * secret settings and connector credentials. After a restore onto a new PC
 * the owner enters these again.
 */
export async function countSealedRows(
  runner: Runner = db(),
): Promise<{ secretSettings: number; connectorCredentials: number }> {
  const { rows } = await runner.raw<{ rows: Array<{ settings: string; connectors: string }> }>(
    `SELECT (SELECT count(*) FROM settings WHERE is_secret) AS settings,
            (SELECT count(*) FROM api_connectors WHERE credential_sealed IS NOT NULL) AS connectors`,
  );
  const row = rows[0];
  return { secretSettings: Number(row?.settings ?? 0), connectorCredentials: Number(row?.connectors ?? 0) };
}
