/**
 * The Backup and Restore buttons of Products, Orders and Parties: one zip per section
 * (`docs/7-STORAGE-BACKUP-RESTORE.md` §9), beside the whole-Master "Back up everything".
 *
 * A restore adds what is missing and puts back what changed since the backup. It never
 * deletes, so anything not in the file stays. One transaction, with every foreign key and
 * trigger on; a preview is the same transaction rolled back. Before it writes, a data-only
 * safety archive of the whole Master goes to `<dataDir>/backups`.
 *
 * Products and parties also restore onto another Master: rows are matched there by code, or
 * by name, and new ones take that Master's own ids. Orders do not: their numbers are this
 * company's.
 *
 * shortcut: the rows of one section are held in memory, move to the archive's paging past ~100k lines.
 */

import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import {
  IMAGE_VARIANTS,
  type SectionBackupName,
  type SectionRestoreResult,
} from '@orderbook/shared';

import { config } from '../config/index.js';
import { db } from '../db/knex.js';
import { requirePermission, type ActorContext } from '../domain/actor.js';
import { companySlug } from '../domain/archive.js';
import { appVersion } from '../lib/app-version.js';
import { createZipWriter, openZipReader, type ZipReader } from '../lib/archive-zip.js';
import { ConflictError, ValidationError } from '../lib/errors.js';
import { recordActivity } from '../repositories/activity-log.repository.js';
import { insertableColumns, resyncSequences } from '../repositories/backup.repository.js';
import {
  allocatePermanentId,
  backfillPendingOrderNumbers,
  nextHlc,
} from '../repositories/identity.repository.js';
import type { TransactionContext } from '../repositories/transaction.js';
import { writeSafetyArchive } from './archive-restore.service.js';
import { isJobRunning, maintenanceError } from './backup-job.js';
import { panelLink } from '../realtime/panel-link.js';
import { publishChange } from './change-bus.js';
import { resetProcessCaches } from './process-caches.js';
import { getIdentity } from './setup.service.js';

type Row = Record<string, unknown>;
type Data = Record<string, Row[]>;

interface Manifest {
  format: string;
  formatVersion: number;
  section: SectionBackupName;
  createdAt: string;
  company: string;
  tenantId: string;
}

const FORMAT = 'orderbook-section-backup';
const FORMAT_VERSION = 1;
const MAX_DATA_BYTES = 512 * 1024 * 1024;
const PRODUCT_LISTS = ['product.brand', 'stock.colour', 'line.packaging'];
const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** Every table of a section, in the order rows go in, with what goes into the file. */
const TABLES: Record<SectionBackupName, ReadonlyArray<readonly [table: string, where: string]>> = {
  products: [
    ['option_lists', `deleted_at IS NULL AND list_key IN (${PRODUCT_LISTS.map((key) => `'${key}'`).join(',')})`],
    ['product_categories', 'deleted_at IS NULL'],
    ['products', 'deleted_at IS NULL'],
    ['product_images', 'product_id IN (SELECT id FROM products WHERE deleted_at IS NULL)'],
  ],
  parties: [
    ['parties', 'deleted_at IS NULL'],
    ['party_access', 'party_id IN (SELECT id FROM parties WHERE deleted_at IS NULL)'],
    ['party_product_variants', 'party_id IN (SELECT id FROM parties WHERE deleted_at IS NULL)'],
  ],
  orders: [
    ['leads', '(deleted_at IS NULL OR id IN (SELECT lead_id FROM orders WHERE deleted_at IS NULL))'],
    ['orders', 'deleted_at IS NULL'],
    ['line_items', liveParent()],
    ['timeline_entries', liveParent()],
  ],
};

function liveParent(): string {
  return `((parent_type = 'lead' AND parent_id IN (SELECT id FROM leads WHERE deleted_at IS NULL OR id IN (SELECT lead_id FROM orders WHERE deleted_at IS NULL)))
        OR (parent_type = 'order' AND parent_id IN (SELECT id FROM orders WHERE deleted_at IS NULL)))`;
}

/** The records of a section: matched, compared and counted. The rest hang off these. */
const RECORDS: Record<SectionBackupName, readonly string[]> = {
  products: ['product_categories', 'products'],
  parties: ['parties'],
  orders: ['leads', 'orders'],
};
const ENTITY = { product_categories: 'product_category', products: 'product', parties: 'party' } as const;

/** About the row or this Master rather than the record: never compared, never a change by themselves. */
const VOLATILE = new Set([
  'id', 'tenant_id', 'version', 'hlc', 'field_hlc', 'created_at', 'updated_at', 'search_vector',
  'temporary_id', 'created_by_user_id', 'source_panel_id', 'deleted_by', 'uploaded_at',
]);

const json = (value: unknown): string => JSON.stringify(value ?? null);
const labelOf = (row: Row): string => String(row.name ?? row.po_number ?? row.id);

async function rowsOf(trx: TransactionContext, table: string, tenantId: string, where = 'TRUE', bind: unknown[] = []): Promise<Row[]> {
  const { rows } = await trx.raw<{ rows: Array<{ row: Row }> }>(
    `SELECT row_to_json(t) AS row FROM ?? t WHERE tenant_id = ? AND ${where} ORDER BY id`,
    [table, tenantId, ...bind] as never,
  );
  return rows.map(({ row }) => row);
}

const imageFile = (tenantId: string, imageId: string, variant: string): string =>
  path.join(config.imagesDir, tenantId, imageId, `${variant}.webp`);

// --- Backup ------------------------------------------------------------------

/** Writes the section's zip to a temporary file. The caller sends it and removes it. */
export async function exportSection(
  section: SectionBackupName,
  actor: ActorContext,
): Promise<{ path: string; fileName: string }> {
  requirePermission(actor, 'storage.manage');
  const identity = await getIdentity();
  if (!identity) throw new ConflictError('error.conflict.notSetUp');

  const data = await db().transaction(async (trx) => {
    await trx.raw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const out: Data = {};
    for (const [table, where] of TABLES[section]) out[table] = await rowsOf(trx, table, actor.tenantId, where);
    return out;
  });

  const createdAt = new Date().toISOString();
  const folder = path.join(config.dataDir, 'tmp');
  await fs.mkdir(folder, { recursive: true });
  const file = path.join(folder, `section-${randomUUID()}.zip`);
  const writer = createZipWriter(file);
  try {
    const manifest: Manifest & { appVersion: string } = {
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      section,
      appVersion: appVersion(),
      createdAt,
      company: identity.companyName ?? '',
      tenantId: actor.tenantId,
    };
    await writer.appendEntry('manifest.json', [JSON.stringify(manifest, null, 2)]);
    await writer.appendEntry('data.json', [JSON.stringify(data)]);
    for (const image of data.product_images ?? []) {
      for (const variant of IMAGE_VARIANTS) {
        const source = imageFile(actor.tenantId, String(image.id), variant);
        if (!(await fs.stat(source).catch(() => null))) continue;
        await writer.appendEntry(`images/${image.id}/${variant}.webp`, createReadStream(source), { store: true });
      }
    }
    await writer.finalize();
  } catch (error) {
    writer.abort();
    await fs.rm(file, { force: true, maxRetries: 5 }).catch(() => undefined);
    throw error;
  }

  const name = section[0]!.toUpperCase() + section.slice(1);
  const fileName = `OrderBook-${name}-${companySlug(identity.companyName)}-${createdAt.slice(0, 10)}.zip`;
  await db().transaction((trx) =>
    recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'backup',
        entityId: createdAt,
        action: 'exported',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { scope: section, fileName },
      },
      actor,
      trx,
    ),
  );
  return { path: file, fileName };
}

// --- Restore -----------------------------------------------------------------

class PreviewDone extends Error {}

async function readSection(reader: ZipReader, section: SectionBackupName): Promise<{ manifest: Manifest; data: Data }> {
  let manifest: Manifest;
  let data: Data;
  try {
    manifest = JSON.parse(await reader.readText('manifest.json', 64 * 1024)) as Manifest;
    data = JSON.parse(await reader.readText('data.json', MAX_DATA_BYTES)) as Data;
  } catch {
    throw new ValidationError('validation.sectionBackup.notABackup');
  }
  if (manifest.format !== FORMAT) throw new ValidationError('validation.sectionBackup.notABackup');
  if (manifest.formatVersion > FORMAT_VERSION) throw new ValidationError('validation.sectionBackup.newer');
  if (manifest.section !== section) throw new ValidationError('validation.sectionBackup.otherSection');
  for (const [table] of TABLES[section]) if (!Array.isArray(data[table])) throw new ValidationError('validation.sectionBackup.notABackup');
  return { manifest, data };
}

/** `file` is a zip on this PC. `apply: false` is the preview: the same work, rolled back. */
export async function restoreSection(
  section: SectionBackupName,
  file: string,
  apply: boolean,
  actor: ActorContext,
): Promise<SectionRestoreResult> {
  requirePermission(actor, 'storage.manage');
  if (isJobRunning()) throw maintenanceError();

  const reader = await openZipReader(file).catch(() => {
    throw new ValidationError('validation.sectionBackup.notABackup');
  });
  try {
    const { manifest, data } = await readSection(reader, section);
    const sameCompany = manifest.tenantId === actor.tenantId;
    if (section === 'orders' && !sameCompany) throw new ValidationError('validation.sectionBackup.otherCompany');

    const result: SectionRestoreResult = {
      section,
      createdAt: manifest.createdAt,
      company: manifest.company,
      sameCompany,
      added: 0,
      changed: 0,
      unchanged: 0,
      photos: 0,
      skipped: [],
    };
    if (apply) await writeSafetyArchive('pre-section-restore-');

    try {
      await db().transaction(async (trx) => {
        await restoreRows({ section, data, sameCompany, reader, apply, actor, trx, result });
        if (!apply) throw new PreviewDone();
        await recordActivity(
          {
            tenantId: actor.tenantId,
            entityType: 'backup',
            entityId: manifest.createdAt,
            action: 'restored',
            actorType: actor.actorType,
            actorId: actor.actorId,
            details: { scope: section, createdAt: manifest.createdAt, added: result.added, changed: result.changed },
          },
          actor,
          trx,
        );
      });
    } catch (error) {
      if (!(error instanceof PreviewDone)) throw readable(error);
    }
    if (apply) {
      // Every open screen reads again and every Office takes a full snapshot, as after a whole restore.
      resetProcessCaches();
      const payload = { added: result.added, changed: result.changed };
      publishChange({ entity: 'catalog', action: 'updated', id: actor.tenantId, payload });
      publishChange({ entity: 'party_bulk', action: 'updated', id: actor.tenantId, payload });
      panelLink()?.resnapshotAll?.();
    }
    return result;
  } finally {
    reader.close();
  }
}

/** A live record holds a code or name the file gives another: said by its value, not as SQL. */
function readable(error: unknown): unknown {
  const { code, detail } = error as { code?: string; detail?: string };
  return code === '23505' ? new ConflictError('validation.sectionBackup.clash', { detail: detail ?? '' }) : error;
}

interface Job {
  section: SectionBackupName;
  data: Data;
  sameCompany: boolean;
  reader: ZipReader;
  apply: boolean;
  actor: ActorContext;
  trx: TransactionContext;
  result: SectionRestoreResult;
}

async function restoreRows(job: Job): Promise<void> {
  const { section, data, trx, actor, result } = job;
  const tenantId = actor.tenantId;
  const hlc = await nextHlc(trx);
  /** Ids in the file to ids here, for the records that were kept. */
  const ids = new Map<string, string>();
  const written = new Set<string>();
  /** Orders with a line whose sub product is gone for good: the line could not be stored. */
  const lost = new Set<string>();
  if (section === 'orders') {
    const known = new Set((await rowsOf(trx, 'products', tenantId)).map((row) => row.id));
    for (const line of data.line_items!) if (!known.has(line.product_id)) lost.add(String(line.parent_id));
  }

  if (section === 'products') {
    for (const row of data.option_lists!) {
      const held = await rowsOf(trx, 'option_lists', tenantId, 'deleted_at IS NULL AND list_key = ? AND value = ?', [row.list_key, row.value]);
      if (held.length === 0) await upsert(trx, 'option_lists', { ...row, id: randomUUID(), tenant_id: tenantId, created_by: null, updated_by: null });
    }
  }

  for (const table of RECORDS[section]) {
    const here = new Map((await rowsOf(trx, table, tenantId)).map((row) => [String(row.id), row]));
    const links = await foreignKeys(trx, table);
    const later: Row[] = [];
    for (const row of data[table]!) {
      const next: Row = { ...row, tenant_id: tenantId };
      for (const { column, table: target } of links) {
        if (ids.has(String(next[column]))) next[column] = ids.get(String(next[column]));
        // Another Master's person or panel: the same id here is somebody else.
        else if (!job.sameCompany && (target === 'users' || target === 'office_panels')) next[column] = null;
      }

      const held = match(table, next, [...here.values()], job.sameCompany);
      const missing = lost.has(String(row.id)) ? 'products' : await settleLinks(trx, links, next, tenantId);
      // An order's number is its new order's: without that there is nothing to name it by.
      const orphan = table === 'orders' && row.lead_id !== null && !ids.has(String(row.lead_id));
      if (missing || orphan) {
        result.skipped.push({ label: labelOf(row), reason: missing ?? 'leads' });
        continue;
      }
      next.id =
        held?.id ??
        (job.sameCompany ? row.id : await allocatePermanentId(tenantId, ENTITY[table as keyof typeof ENTITY], trx));
      ids.set(String(row.id), String(next.id));
      if (table === 'parties') {
        // A code names one live party; the one already here keeps its own.
        if (held) next.party_code = held.party_code;
        else if (!job.sameCompany) next.party_code = null;
      }
      if (table === 'leads') later.push({ id: next.id, converted_order_id: row.converted_order_id });

      const same =
        held !== undefined &&
        Object.keys(row).every(
          (key) => VOLATILE.has(key) || !(key in held) || key === 'converted_order_id' || json(held[key]) === json(next[key]),
        ) &&
        (section !== 'orders' || (await sameLines(job, String(next.id))));
      if (same) {
        result.unchanged += 1;
        continue;
      }
      if (held) result.changed += 1;
      else result.added += 1;
      written.add(String(next.id));
      await upsert(trx, table, stamped(next, held, hlc));
      here.set(String(next.id), next);
    }
    if (table === 'orders') await linkConverted(trx, data.leads!, ids, written);
  }

  if (section === 'products') await restorePhotos(job, ids);
  if (section === 'parties' && job.sameCompany) {
    for (const table of ['party_access', 'party_product_variants']) {
      const links = await foreignKeys(trx, table);
      for (const row of data[table]!) {
        const next: Row = { ...row, tenant_id: tenantId, party_id: ids.get(String(row.party_id)) };
        if (!next.party_id || (await settleLinks(trx, links, next, tenantId))) continue;
        if (table === 'party_access' && (await rowsOf(trx, 'users', tenantId, 'id = ?', [next.user_id])).length === 0) continue;
        await upsert(trx, table, next, true);
      }
    }
  }
  if (section === 'orders') {
    for (const id of written) await trx('line_items').where({ tenant_id: tenantId, parent_id: id }).delete();
    const products = await foreignKeys(trx, 'line_items');
    for (const row of data.line_items!) {
      if (!written.has(String(row.parent_id))) continue;
      const next: Row = { ...row, tenant_id: tenantId };
      await settleLinks(trx, products.filter((link) => !link.required), next, tenantId);
      await upsert(trx, 'line_items', next);
    }
    const stages = await foreignKeys(trx, 'timeline_entries');
    for (const row of data.timeline_entries!) {
      if (!written.has(String(row.parent_id))) continue;
      const next: Row = { ...row, tenant_id: tenantId };
      await settleLinks(trx, stages, next, tenantId);
      await upsert(trx, 'timeline_entries', next, true);
    }
    // Numbers and counters end past everything that came back: none is ever used twice.
    await backfillPendingOrderNumbers(trx);
  }
  if (job.sameCompany) await bumpCounters(trx, tenantId);
  if (section === 'parties') await resyncSequences(trx, ['parties']);
}

/** The record here that a row in the file is: by id on its own Master, else by code, else by name. */
function match(table: string, row: Row, here: Row[], sameCompany: boolean): Row | undefined {
  const live = here.filter((held) => held.deleted_at === null);
  const equal = (held: Row, ...keys: string[]): boolean =>
    keys.every((key) => String(held[key] ?? '').toLowerCase() === String(row[key] ?? '').toLowerCase());
  const own = sameCompany ? here.find((held) => held.id === row.id) : undefined;
  if (own && own.deleted_at === null) return own;
  const natural =
    table === 'product_categories'
      ? (live.find((held) => row.code && equal(held, 'code')) ?? live.find((held) => equal(held, 'brand', 'name')))
      : table === 'products'
        ? (live.find((held) => row.code && equal(held, 'code')) ?? live.find((held) => equal(held, 'category_id', 'name')))
        : table === 'parties'
          ? live.find((held) => equal(held, 'name', 'phone'))
          : undefined;
  return natural ?? own;
}

interface Link {
  column: string;
  table: string;
  required: boolean;
}

async function foreignKeys(trx: TransactionContext, table: string): Promise<Link[]> {
  const { rows } = await trx.raw<{ rows: Link[] }>(
    `SELECT a.attname AS "column", c.confrelid::regclass::text AS "table", a.attnotnull AS required
       FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE c.contype = 'f' AND c.conrelid = ?::regclass AND c.confrelid <> 'tenants'::regclass`,
    [table],
  );
  return rows;
}

/** A missing optional link (a person, a panel) is dropped. A missing required one answers its table. */
async function settleLinks(trx: TransactionContext, links: Link[], row: Row, tenantId: string): Promise<string | null> {
  for (const { column, table, required } of links) {
    const value = row[column];
    if (value === null || value === undefined) continue;
    const query = trx(table).where({ id: value as string });
    if (required && (table === 'parties' || table === 'products' || table === 'product_categories')) {
      void query.where({ tenant_id: tenantId }).whereNull('deleted_at');
    }
    if (await query.first('id')) continue;
    if (required) return table;
    row[column] = null;
  }
  return null;
}

/** A record's lines as stored, against the file's. */
async function sameLines(job: Job, parentId: string): Promise<boolean> {
  const clean = (rows: Row[]): string =>
    json(rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !VOLATILE.has(key)).sort())));
  const held = await rowsOf(job.trx, 'line_items', job.actor.tenantId, 'parent_id = ?', [parentId]);
  const filed = job.data.line_items!
    .filter((row) => row.parent_id === parentId)
    .sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1));
  return clean(held) === clean(filed);
}

function stamped(next: Row, held: Row | undefined, hlc: string): Row {
  if (!('field_hlc' in next)) return { ...next, deleted_at: null };
  const clocks = Object.keys({ ...(held?.field_hlc as Row), ...(next.field_hlc as Row) });
  return {
    ...next,
    // A binned new order behind a live final order stays binned, as it was backed up.
    deleted_at: next.deleted_at ?? null,
    deleted_by: next.deleted_at ? (held?.deleted_by ?? null) : null,
    temporary_id: held?.temporary_id ?? null,
    version: Number(held?.version ?? 0) + 1,
    hlc,
    field_hlc: Object.fromEntries(clocks.map((field) => [field, hlc])),
    updated_at: new Date().toISOString(),
  };
}

/** The columns a table takes, asked once per restore. */
const columnsOf = new WeakMap<TransactionContext, Map<string, string[]>>();

async function upsert(trx: TransactionContext, table: string, row: Row, keep = false): Promise<void> {
  const known = columnsOf.get(trx) ?? new Map<string, string[]>();
  columnsOf.set(trx, known);
  const columns =
    known.get(table) ??
    (await insertableColumns(table, trx, Object.keys(row))).filter((column) => column !== 'search_vector');
  known.set(table, columns);
  const names = columns.map((column) => `"${column}"`);
  if (table === 'parties' && row.party_code === null) {
    const { rows } = await trx.raw<{ rows: [{ code: string }] }>(
      `SELECT 'P-' || lpad(s::text, greatest(4, length(s::text)), '0') AS code FROM (SELECT nextval('party_code_seq') AS s) n`,
    );
    row.party_code = rows[0].code;
  }
  await trx.raw(
    `INSERT INTO ?? (${names.join(',')}) SELECT ${names.join(',')} FROM json_populate_record(NULL::"${table}", ?)
     ${keep ? 'ON CONFLICT DO NOTHING' : `ON CONFLICT (id) DO UPDATE SET ${names.map((name) => `${name} = EXCLUDED.${name}`).join(',')}`}`,
    [table, JSON.stringify(row)],
  );
}

/** A new order went in before its final order existed; point it there now. */
async function linkConverted(trx: TransactionContext, leads: Row[], ids: Map<string, string>, written: Set<string>): Promise<void> {
  for (const lead of leads) {
    if (!written.has(String(lead.id)) || !ids.has(String(lead.converted_order_id))) continue;
    await trx('leads').where({ id: lead.id as string }).update({ converted_order_id: lead.converted_order_id as string });
  }
}

async function bumpCounters(trx: TransactionContext, tenantId: string): Promise<void> {
  for (const [entity, table] of [
    ['product_category', 'product_categories'], ['product', 'products'], ['party', 'parties'],
    ['lead', 'leads'], ['order', 'orders'], ['line_item', 'line_items'], ['timeline_entry', 'timeline_entries'],
  ] as const) {
    await trx.raw(
      `UPDATE id_sequences SET next_value = GREATEST(next_value, (SELECT COALESCE(max(substring(id FROM '[0-9]+$')::bigint), 0) + 1 FROM ?? WHERE tenant_id = ?))
        WHERE tenant_id = ? AND entity = ?`,
      [table, tenantId, tenantId, entity],
    );
  }
}

/** Photos missing here, with their files. A photo is the same one by id, or by the file it was made from. */
async function restorePhotos(job: Job, ids: Map<string, string>): Promise<void> {
  const { trx, actor, reader, result } = job;
  const entries = new Set(reader.entries.map((entry) => entry.name));
  const all = await rowsOf(trx, 'product_images', actor.tenantId);
  for (const row of job.data.product_images!) {
    const productId = ids.get(String(row.product_id));
    if (!productId || !UUID.test(String(row.id)) || !entries.has(`images/${row.id}/master.webp`)) continue;
    const held = all.filter((image) => image.product_id === productId);
    if (held.some((image) => image.id === row.id || (row.checksum !== null && image.checksum === row.checksum))) continue;
    const taken = await trx('product_images').where({ id: row.id as string }).first('id');
    const id = taken ? randomUUID() : String(row.id);
    result.photos += 1;
    if (!job.apply) continue;
    for (const variant of IMAGE_VARIANTS) {
      if (!entries.has(`images/${row.id}/${variant}.webp`)) continue;
      const target = imageFile(actor.tenantId, id, variant);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await pipeline(await reader.openStream(`images/${row.id}/${variant}.webp`), createWriteStream(target));
    }
    const next = { ...row, id, tenant_id: actor.tenantId, product_id: productId, is_primary: held.length === 0 && row.is_primary === true };
    await upsert(trx, 'product_images', next);
    all.push(next);
  }
}
