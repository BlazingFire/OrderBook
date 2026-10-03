/**
 * Back up everything, change things, restore: every table comes back row for
 * row, every photo byte for byte, and the pairing with the Office panels is
 * kept (`archive-export.service.ts`, `archive-restore.service.ts`).
 *
 * Rows are compared as Postgres renders them (`row_to_json`), so a timestamp
 * that lost its microseconds or a JSONB array that came back as a string fails
 * here. Two differences are expected and taken out before comparing: the
 * restore's own `backup.restored` entries, and the Master's LAN address, which
 * a restore refreshes to this PC's.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { config } from '../src/config/index.js';
import { db } from '../src/db/knex.js';
import { MANIFEST_ENTRY, MAX_MANIFEST_BYTES, parseArchiveManifest } from '../src/domain/archive.js';
import { openZipReader } from '../src/lib/archive-zip.js';
import * as changeRing from '../src/realtime/change-ring.js';
import { listUserTables, verifyActivityLogChain } from '../src/repositories/backup.repository.js';
import * as panelRepo from '../src/repositories/office-panel.repository.js';
import { exportArchive } from '../src/services/archive-export.service.js';
import { previewArchive, restoreArchive } from '../src/services/archive-restore.service.js';
import { isMaintenance } from '../src/services/backup-job.js';
import * as catalog from '../src/services/catalog.service.js';
import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setUpFirstRun, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';

/** Every table, each as its rows' JSON text, sorted. */
async function dumpAll(): Promise<Record<string, string[]>> {
  const dump: Record<string, string[]> = {};
  for (const table of await listUserTables()) {
    const { rows } = await db().raw<{ rows: Array<{ j: string }> }>(
      `SELECT row_to_json(t)::text AS j FROM ?? t ORDER BY 1`,
      [table],
    );
    dump[table] = rows.map((row) => row.j);
  }
  return dump;
}

/** What a restore is expected to change, taken out of a dump. */
function comparable(dump: Record<string, string[]>): Record<string, string[]> {
  return {
    ...dump,
    activity_log: (dump.activity_log ?? []).filter((json) => {
      const row = JSON.parse(json) as { entity_type: string; action: string };
      return !(row.entity_type === 'backup' && row.action === 'restored');
    }),
    master_config: (dump.master_config ?? []).map((json) => {
      const { lan_ip: _lanIp, ...rest } = JSON.parse(json) as Record<string, unknown>;
      return JSON.stringify(rest);
    }),
  };
}

describe.skipIf(!canRunIntegrationTests)('backup all: export, then restore (integration)', () => {
  let folder: string;
  const photoFiles: string[] = [];

  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    folder = await mkdtemp(path.join(os.tmpdir(), 'ob-archive-roundtrip-'));
  });
  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
    for (const file of photoFiles.splice(0)) await rm(file, { force: true });
  });

  it('brings back identical rows and photos, keeps the pairing, and starts a new change-ring boot', async () => {
    await setUpFirstRun('Roundtrip Ceramics');
    const actor = await testActor();
    const party = await catalog.createParty({ name: 'Roundtrip Traders' }, actor);
    await catalog.createProduct({ categoryName: 'Tiles', variants: [{ code: 'RT-01' }], name: 'Round Tile' }, actor);

    // A paired Office panel, with the proof key its rediscovery needs.
    const panelId = randomUUID();
    await panelRepo.insertPanel({
      id: panelId,
      tenant_id: actor.tenantId,
      name: 'Front desk',
      device_code: 'A',
      secret_hash: 'scrypt$kept-as-is',
      master_proof_key: 'proof-key-kept-as-is',
      lan_ip: '192.168.1.20',
      status: 'active',
      paired_at: new Date(),
    });

    // A product photo variant and an avatar, as the image and avatar services lay them out.
    const image = path.join(config.imagesDir, actor.tenantId, `IMGRT${Date.now()}`, 'thumb.webp');
    const avatar = path.join(config.imagesDir, actor.tenantId, 'avatars', `rt-${Date.now()}.webp`);
    const imageBytes = randomBytes(5000);
    const avatarBytes = randomBytes(1200);
    for (const [file, bytes] of [
      [image, imageBytes],
      [avatar, avatarBytes],
    ] as const) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, bytes);
      photoFiles.push(file);
    }

    const before = await dumpAll();
    const exported = await exportArchive({ folder, actor });

    // One finished file, no .partial, and nothing that never travels.
    expect(await readdir(folder)).toEqual([exported.fileName]);
    const reader = await openZipReader(exported.path);
    try {
      const names = reader.entries.map((entry) => entry.name);
      expect(names.some((name) => /user_password_vault|master_clock|knex_|secrets\//.test(name))).toBe(false);
      const manifest = parseArchiveManifest(await reader.readText(MANIFEST_ENTRY, MAX_MANIFEST_BYTES));
      expect(manifest.tables.map((table) => table.name).sort()).toEqual(Object.keys(before).sort());
      expect(manifest.company).toBe('Roundtrip Ceramics');
      const relative = (file: string) =>
        `uploads/${path.relative(config.uploadsDir, file).split(path.sep).join('/')}`;
      expect(names).toContain(relative(image));
      expect(names).toContain(relative(avatar));
    } finally {
      reader.close();
    }

    const preview = await previewArchive(exported.path);
    expect(preview).toMatchObject({ company: 'Roundtrip Ceramics', counts: { parties: 1, products: 1 } });

    // Things change after the backup.
    await catalog.deleteParty(party.id, actor);
    await catalog.createParty({ name: 'Made After The Backup' }, actor);
    await rm(image);
    const bootBefore = changeRing.BOOT_ID;

    const restored = await restoreArchive(exported.path, { mode: 'replace', actor });

    expect(comparable(await dumpAll())).toEqual(comparable(before));
    expect(await readFile(image)).toEqual(imageBytes);
    expect(await readFile(avatar)).toEqual(avatarBytes);

    // The pairing came back as it was, not revoked.
    const panel = await db()('office_panels').where({ id: panelId }).first();
    expect(panel).toMatchObject({ status: 'active', secret_hash: 'scrypt$kept-as-is', master_proof_key: 'proof-key-kept-as-is' });

    // The trail is intact, with the restore on it.
    expect(
      await db()('activity_log').where({ tenant_id: actor.tenantId, entity_type: 'backup', action: 'restored' }),
    ).toHaveLength(1);
    expect(await db().transaction((trx) => verifyActivityLogChain(trx, [actor.tenantId]))).toBe(true);

    // Sequences are past the restored rows: a new party gets a new code.
    const next = await catalog.createParty({ name: 'After The Restore' }, actor);
    const codes = (await db()('parties').select<Array<{ party_code: string }>>('party_code')).map((row) => row.party_code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(next.id).toBeTruthy();

    expect(changeRing.BOOT_ID).not.toBe(bootBefore);
    expect(isMaintenance()).toBe(false);
    expect(restored.safetyArchivePath).toMatch(/pre-restore-.*\.zip$/);
    expect(path.dirname(restored.safetyArchivePath ?? '')).toBe(path.join(config.dataDir, 'backups'));
  });

  it('refuses Magic restore on a Master already set up, before reading the archive', async () => {
    await setUpFirstRun('Already Here');
    const exported = await exportArchive({ folder });

    await expect(restoreArchive(exported.path, { mode: 'first-run' })).rejects.toMatchObject({
      messageKey: 'error.conflict.alreadySetUp',
    });
    expect(isMaintenance()).toBe(false);
  });
});
