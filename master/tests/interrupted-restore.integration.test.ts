/**
 * A power cut during a restore (`resumeInterruptedRestore`): the schema is dropped
 * outside any transaction, so without this the Master came back empty, on the
 * first-run screen. Each test leaves the database the way a dead process would, and
 * the next boot has to put it right.
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { config } from '../src/config/index.js';
import { db, runMigrations } from '../src/db/knex.js';
import { exportArchive } from '../src/services/archive-export.service.js';
import {
  reportInterruptedRestore,
  restoreArchive,
  resumeInterruptedRestore,
  type RestoreMarker,
} from '../src/services/archive-restore.service.js';
import * as catalog from '../src/services/catalog.service.js';
import { isSetupComplete } from '../src/services/setup.service.js';
import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setUpFirstRun, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';

const markerPath = (): string => path.join(config.dataDir, 'restore-pending.json');
const exists = (file: string): Promise<boolean> => stat(file).then(
  () => true,
  () => false,
);
const dropSchema = (): Promise<unknown> => db().raw('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');

describe.skipIf(!canRunIntegrationTests)('a restore a shutdown interrupted (integration)', () => {
  let folder: string;

  async function companyWithAParty(): Promise<{ partyId: string; copy: string }> {
    await setUpFirstRun('Shree Ceramics');
    const party = await catalog.createParty({ name: 'Patel Sanitary' }, await testActor());
    const { path: copy } = await exportArchive({ folder, includeUploads: false, audit: false });
    return { partyId: party.id, copy };
  }

  async function leaveMarker(marker: Partial<RestoreMarker>): Promise<void> {
    await writeFile(
      markerPath(),
      JSON.stringify({ mode: 'replace', safetyArchivePath: null, file: 'old.zip', startedAt: '2026-11-06T10:00:00.000Z', ...marker }),
    );
  }

  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    folder = await mkdtemp(path.join(os.tmpdir(), 'ob-interrupted-restore-'));
  });
  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
    await rm(markerPath(), { force: true });
  });

  it('does nothing at all on an ordinary boot', async () => {
    const { partyId } = await companyWithAParty();
    expect(await resumeInterruptedRestore()).toBeNull();
    expect(await db()('parties').where({ id: partyId }).first()).toBeDefined();
  });

  it('puts back the data from before the restore when it died after the drop', async () => {
    const { partyId, copy } = await companyWithAParty();
    await leaveMarker({ safetyArchivePath: copy });
    const work = path.join(config.dataDir, 'tmp', 'restore-dead-job');
    await mkdir(work, { recursive: true });
    await dropSchema();

    const resumed = await resumeInterruptedRestore();

    expect(resumed?.file).toBe('old.zip');
    expect(await isSetupComplete()).toBe(true);
    expect(await db()('parties').where({ id: partyId }).first()).toBeDefined();
    expect(await exists(markerPath())).toBe(false);
    expect(await exists(work)).toBe(false);
  });

  it('also goes back when the restore had committed but the photos were never swapped', async () => {
    const { partyId, copy } = await companyWithAParty();
    await leaveMarker({ safetyArchivePath: copy });
    // The records the dead restore brought in, with the old photos still in place.
    await db()('parties').where({ id: partyId }).update({ name: 'From the restore' });

    await resumeInterruptedRestore();

    expect((await db()('parties').where({ id: partyId }).first()).name).toBe('Patel Sanitary');
  });

  it('goes back to an empty first-run screen when a first-run restore died', async () => {
    await leaveMarker({ mode: 'first-run' });
    await dropSchema();

    expect((await resumeInterruptedRestore())?.mode).toBe('first-run');

    expect(await isSetupComplete()).toBe(false);
    expect(await exists(markerPath())).toBe(false);
  });

  it('stops the boot, naming the file, rather than opening an empty Master', async () => {
    await leaveMarker({ safetyArchivePath: path.join(folder, 'gone.zip') });
    await dropSchema();

    try {
      await expect(resumeInterruptedRestore()).rejects.toThrow(/gone\.zip/);
      expect(await exists(markerPath())).toBe(true);
    } finally {
      await runMigrations();
    }
  });

  it('keeps running on its own data when the drop never happened and the copy is damaged', async () => {
    const { partyId } = await companyWithAParty();
    const damaged = path.join(folder, 'damaged.zip');
    await writeFile(damaged, 'not a zip');
    await leaveMarker({ safetyArchivePath: damaged });

    expect(await resumeInterruptedRestore()).toBeNull();

    expect(await db()('parties').where({ id: partyId }).first()).toBeDefined();
    expect(await exists(markerPath())).toBe(false);
  });

  it('ignores a marker it cannot read, and touches nothing', async () => {
    const { partyId } = await companyWithAParty();
    await writeFile(markerPath(), '{ not json');

    expect(await resumeInterruptedRestore()).toBeNull();

    expect(await db()('parties').where({ id: partyId }).first()).toBeDefined();
  });

  it('tells the Server Masters and the trail what happened', async () => {
    await setUpFirstRun('Shree Ceramics');

    await reportInterruptedRestore({
      mode: 'replace',
      safetyArchivePath: null,
      file: 'old.zip',
      startedAt: '2026-11-06T10:00:00.000Z',
    });

    const notices = await db()('user_notifications').where({ kind: 'backup.restoreInterrupted' });
    expect(notices.length).toBeGreaterThan(0);
    expect(notices[0].params).toEqual({ file: 'old.zip' });
    expect(await db()('activity_log').where({ entity_type: 'backup', action: 'restore_failed' })).toHaveLength(1);
  });

  it('leaves no marker behind after a restore that worked', async () => {
    const { partyId, copy } = await companyWithAParty();
    await db()('parties').where({ id: partyId }).update({ name: 'Changed since' });

    await restoreArchive(copy, { mode: 'replace' });

    expect(await exists(markerPath())).toBe(false);
    expect((await db()('parties').where({ id: partyId }).first()).name).toBe('Patel Sanitary');
    // And a next boot leaves that restore alone.
    expect(await resumeInterruptedRestore()).toBeNull();
    expect((await db()('parties').where({ id: partyId }).first()).name).toBe('Patel Sanitary');
  });

  it('runs at boot before the migrations, which would make a dropped schema look like a new install', async () => {
    const boot = await readFile(path.join(import.meta.dirname, '..', 'src', 'index.ts'), 'utf8');
    expect(boot.indexOf('await resumeInterruptedRestore()')).toBeGreaterThan(-1);
    expect(boot.indexOf('await resumeInterruptedRestore()')).toBeLessThan(boot.indexOf('await runMigrations()'));
  });
});
