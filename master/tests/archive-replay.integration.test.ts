/**
 * A restore replays the archive at its own schema level and then runs the
 * newer migrations over it, so an archive from an older version comes back
 * exactly as an in-place update would have left it — pending-order numbers
 * back-filled included (`archive-restore.service.ts`).
 *
 * The "older" archive is a real export rewritten here: the pending-order
 * number migration and everything after it are taken off the manifest, and
 * the column and counters that migration adds are taken out of the rows, with
 * the hashes recomputed. The same rewrite makes the two archives that must be
 * refused before anything is touched: one from a newer version, and one with
 * a changed byte.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ArchiveManifest, LeadInput } from '@orderbook/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { db } from '../src/db/knex.js';
import { migrations } from '../src/db/migrations/index.js';
import type { ActorContext } from '../src/domain/actor.js';
import { MANIFEST_ENTRY, MAX_MANIFEST_BYTES, tableEntryName } from '../src/domain/archive.js';
import { createZipWriter, openZipReader } from '../src/lib/archive-zip.js';
import { exportArchive } from '../src/services/archive-export.service.js';
import { previewArchive, restoreArchive } from '../src/services/archive-restore.service.js';
import { isMaintenance } from '../src/services/backup-job.js';
import * as catalog from '../src/services/catalog.service.js';
import * as leads from '../src/services/lead.service.js';
import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setUpFirstRun, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';

const PO_MIGRATION = '20261003000000_pending_order_numbers';

interface Rewrite {
  /** Table entries to leave out, for tables that do not exist at the older schema level. */
  dropTables?: string[];
  /** Entry name to a function of its text. */
  entries?: Record<string, (text: string) => string>;
  manifest?: (manifest: ArchiveManifest) => void;
  /** Leave the manifest's sizes and hashes as they were, to plant a corrupt entry. */
  keepHashes?: boolean;
}

/** Copy an archive entry by entry, changing what `rewrite` says, into `target`. */
async function rewriteArchive(source: string, target: string, rewrite: Rewrite): Promise<void> {
  const reader = await openZipReader(source);
  const manifest = JSON.parse(await reader.readText(MANIFEST_ENTRY, MAX_MANIFEST_BYTES)) as ArchiveManifest;
  const writer = createZipWriter(target);
  try {
    for (const { name } of reader.entries) {
      if (name === MANIFEST_ENTRY) continue;
      if (rewrite.dropTables?.some((table) => tableEntryName(table) === name)) continue;
      const chunks: Buffer[] = [];
      for await (const chunk of await reader.openStream(name)) chunks.push(chunk as Buffer);
      let data = Buffer.concat(chunks);
      const edit = rewrite.entries?.[name];
      if (edit) data = Buffer.from(edit(data.toString('utf8')), 'utf8');

      const digest = await writer.appendEntry(name, [data]);
      if (rewrite.keepHashes) continue;
      const table = manifest.tables.find((entry) => tableEntryName(entry.name) === name);
      if (table) {
        Object.assign(table, digest);
        table.rows = data.toString('utf8').split('\n').filter(Boolean).length;
      }
      const upload = manifest.uploads.find((entry) => entry.path === name);
      if (upload) Object.assign(upload, digest);
    }
    manifest.tables = manifest.tables.filter((entry) => !rewrite.dropTables?.includes(entry.name));
    rewrite.manifest?.(manifest);
    await writer.appendEntry(MANIFEST_ENTRY, [JSON.stringify(manifest)]);
    await writer.finalize();
  } catch (error) {
    writer.abort();
    throw error;
  } finally {
    reader.close();
  }
}

describe.skipIf(!canRunIntegrationTests)('archive restore across schema levels (integration)', () => {
  let folder: string;
  let actor: ActorContext;
  let draft: LeadInput;

  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    await setUpFirstRun('Replay Ceramics');
    actor = await testActor();
    folder = await mkdtemp(path.join(os.tmpdir(), 'ob-archive-replay-'));
    const party = await catalog.createParty({ name: 'Replay Traders' }, actor);
    const product = await catalog.createProduct(
      { categoryName: 'Tiles', variants: [{ code: 'RP-01' }], name: 'Replay Tile' },
      actor,
    );
    draft = {
      partyId: party.id,
      items: [{ productId: product.id, variantId: product.variants[0]!.id, quantity: 1, packaging: 'Box' }],
    };
  });
  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it('restores an archive from before pending-order numbers and numbers its leads on the way up', async () => {
    const lead = await leads.createLead(draft, actor);
    const number = (await db()('leads').where({ id: lead.id }).first<{ po_number: string }>('po_number'))!.po_number;
    expect(number).toMatch(/^PO\/\d{4}-\d{2}\/00001$/);

    const exported = await exportArchive({ folder });
    const older = path.join(folder, 'older.zip');
    const level = migrations.map((migration) => migration.name);
    const keep = new Set(level.slice(0, level.indexOf(PO_MIGRATION)));
    await rewriteArchive(exported.path, older, {
      // Tables from the Chatroom, Printroom, notice board and To-do list migrations, which come after this level.
      dropTables: [
        'chat_rooms',
        'chat_members',
        'chat_messages',
        'print_stations',
        'print_jobs',
        'notice_reads',
        'notice_audiences',
        'notices',
        'todo_marks',
        'todos',
      ],
      entries: {
        // The column the migration adds, and the counters it seeds.
        [tableEntryName('leads')]: (text) => text.replace(/,"po_number":(null|"[^"]*")/g, ''),
        [tableEntryName('id_sequences')]: (text) =>
          text
            .split('\n')
            .filter((line) => !line.includes('"entity":"po:'))
            .join('\n'),
      },
      manifest: (manifest) => {
        manifest.appliedMigrations = manifest.appliedMigrations.filter((name) => keep.has(name));
      },
    });

    await leads.deleteLead(lead.id, actor);
    await restoreArchive(older, { mode: 'replace', actor });

    // Back, and numbered again by the migration replayed over it.
    expect((await db()('leads').where({ id: lead.id }).first<{ po_number: string; deleted_at: unknown }>())).toMatchObject({
      po_number: number,
      deleted_at: null,
    });
    const applied = (await db()('knex_migrations').orderBy('id').select<Array<{ name: string }>>('name')).map(
      (row) => row.name,
    );
    expect(applied).toEqual(level);
    expect(await db()('id_sequences').where('entity', 'like', 'po:%').andWhere({ tenant_id: actor.tenantId })).toHaveLength(1);
    expect(isMaintenance()).toBe(false);
  });

  it('refuses an archive from a newer version in the preview and the restore, touching nothing', async () => {
    const exported = await exportArchive({ folder });
    const newer = path.join(folder, 'newer.zip');
    await rewriteArchive(exported.path, newer, {
      manifest: (manifest) => {
        manifest.appliedMigrations.push('29990101000000_from_a_later_version');
      },
    });
    const later = await catalog.createParty({ name: 'Made After The Backup' }, actor);

    await expect(previewArchive(newer)).rejects.toMatchObject({ reason: 'newerThanApp' });
    await expect(restoreArchive(newer, { mode: 'replace', actor })).rejects.toMatchObject({ reason: 'newerThanApp' });

    expect(await db()('parties').where({ id: later.id }).first()).toBeTruthy();
    expect(isMaintenance()).toBe(false);
  });

  it('refuses a changed byte before maintenance, with the live data untouched', async () => {
    const exported = await exportArchive({ folder });
    const tampered = path.join(folder, 'tampered.zip');
    await rewriteArchive(exported.path, tampered, {
      // Same length, so only the hash can tell.
      entries: { [tableEntryName('parties')]: (text) => text.replace('Replay Traders', 'Replay Tradexs') },
      keepHashes: true,
    });
    const later = await catalog.createParty({ name: 'Made After The Backup' }, actor);

    await expect(restoreArchive(tampered, { mode: 'replace', actor })).rejects.toMatchObject({ reason: 'corrupt_file' });

    expect(await db()('parties').where({ id: later.id }).first()).toBeTruthy();
    expect(isMaintenance()).toBe(false);
  });
});
