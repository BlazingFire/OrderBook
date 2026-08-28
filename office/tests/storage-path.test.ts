/**
 * Moving an Office Panel's data folder, on the panel's own terms.
 *
 * This runs unattended: the request arrives over a socket from a Master on
 * another machine, triggered by somebody who cannot see this PC's drives. So
 * every refusal has to happen *before* anything moves, and the original folder
 * has to survive — a half-finished move with the source deleted would be
 * unrecoverable from where that person is standing.
 *
 * Deliberately free of a database and a Master. The panel's promise is that it
 * keeps working with neither, and a test of its filesystem behaviour that
 * needed either would be testing something else.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dataDir: string;
let root: string;

/**
 * `config` is mocked rather than driven through `ORDERBOOK_OFFICE_DATA_DIR`,
 * for one specific reason: a relocation persists the new folder into
 * `config.settingsFile`, and the real one is `office/.env` in this repository.
 * A test that wrote there would leave every later `npm run dev:office` pointed
 * at a deleted temp directory.
 *
 * Fresh module registry per test as well — a relocation is process-wide state
 * that must not leak from one test into the next.
 */
async function loadPaths() {
  vi.doMock('../src/config/index.js', () => ({
    config: {
      dataDir,
      packageRoot: root,
      // Beside the data directory, never inside it — this is the file that
      // records *where* the data directory is, so a move must not carry it
      // along and leave the next start looking in the old place.
      settingsFile: path.join(root, 'office-settings.env'),
      http: { port: 4200 },
      hostname: 'test-pc',
    },
  }));

  const paths = await import('../src/config/paths.js');
  paths.resetPathsForTest();
  return paths;
}

async function seedDataDir(): Promise<void> {
  await fs.mkdir(path.join(dataDir, 'images', 'IM1'), { recursive: true });
  await fs.writeFile(path.join(dataDir, 'outbox.json'), '{"mutations":[]}', { mode: 0o600 });
  await fs.writeFile(path.join(dataDir, 'pairing.json'), '{"panelId":"p1"}', { mode: 0o600 });
  await fs.writeFile(path.join(dataDir, 'images', 'IM1', 'card.webp'), 'not-really-an-image');
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'orderbook-storage-'));
  dataDir = path.join(root, 'current');
  await fs.mkdir(dataDir, { recursive: true });

  vi.resetModules();
});

afterEach(async () => {
  vi.doUnmock('../src/config/index.js');
  await fs.rm(root, { recursive: true, force: true });
});

describe('where the panel keeps its files', () => {
  it('derives every file from the configured folder', async () => {
    const { paths } = await loadPaths();
    const current = paths();

    expect(current.dataDir).toBe(dataDir);
    expect(current.outboxFile).toBe(path.join(dataDir, 'outbox.json'));
    expect(current.credentialsFile).toBe(path.join(dataDir, 'pairing.json'));
    expect(current.imagesDir).toBe(path.join(dataDir, 'images'));
  });

  it('answers with the new folder the moment a move completes', async () => {
    const { paths, relocateDataDir } = await loadPaths();
    await seedDataDir();
    const target = path.join(root, 'moved');

    await relocateDataDir(target, { moveExisting: true });

    // The whole reason paths are a function call: every store reads through
    // this, so work saved after the move lands at the new path rather than
    // being stranded in the old folder until somebody restarts the panel.
    expect(paths().dataDir).toBe(target);
    expect(paths().outboxFile).toBe(path.join(target, 'outbox.json'));
  });
});

describe('moving the data folder', () => {
  it('copies every file across, subfolders included', async () => {
    const { relocateDataDir } = await loadPaths();
    await seedDataDir();
    const target = path.join(root, 'moved');

    const result = await relocateDataDir(target, { moveExisting: true });

    expect(result.filesMoved).toBe(3);
    expect(result.previousDataDir).toBe(dataDir);
    await expect(fs.readFile(path.join(target, 'outbox.json'), 'utf8')).resolves.toBe(
      '{"mutations":[]}',
    );
    await expect(
      fs.readFile(path.join(target, 'images', 'IM1', 'card.webp'), 'utf8'),
    ).resolves.toBe('not-really-an-image');
  });

  it('leaves the original where it is, for somebody at that PC to delete', async () => {
    const { relocateDataDir } = await loadPaths();
    await seedDataDir();

    await relocateDataDir(path.join(root, 'moved'), { moveExisting: true });

    await expect(fs.readFile(path.join(dataDir, 'outbox.json'), 'utf8')).resolves.toBe(
      '{"mutations":[]}',
    );
  });

  it('keeps the secrets unreadable to other accounts at the new path', async () => {
    const { relocateDataDir } = await loadPaths();
    await seedDataDir();
    const target = path.join(root, 'moved');

    await relocateDataDir(target, { moveExisting: true });

    // `pairing.json` is this panel's secret and `users.json` holds offline
    // verifiers; a copy that landed world-readable would undo the 0o600 the
    // stores write them with.
    const stats = await fs.stat(path.join(target, 'pairing.json'));
    expect(stats.mode & 0o077).toBe(0);
  });

  it('starts clean when told not to bring anything', async () => {
    const { relocateDataDir } = await loadPaths();
    await seedDataDir();
    const target = path.join(root, 'empty-start');

    const result = await relocateDataDir(target, { moveExisting: false });

    expect(result.filesMoved).toBe(0);
    await expect(fs.readdir(target)).resolves.toEqual([]);
  });

  it('creates the folder when it does not exist yet', async () => {
    const { relocateDataDir } = await loadPaths();
    const target = path.join(root, 'a', 'b', 'c');

    await relocateDataDir(target, { moveExisting: false });

    await expect(fs.stat(target)).resolves.toBeTruthy();
  });
});

describe('refusing a move', () => {
  it('refuses the folder it is already using', async () => {
    const { relocateDataDir } = await loadPaths();
    await expect(relocateDataDir(dataDir, { moveExisting: true })).rejects.toThrow(/already/i);
  });

  it('refuses a folder inside the current one — the copy would walk its own output', async () => {
    const { relocateDataDir } = await loadPaths();
    await expect(
      relocateDataDir(path.join(dataDir, 'nested'), { moveExisting: true }),
    ).rejects.toThrow(/not inside/i);
  });

  it('refuses a folder that contains the current one, for the same reason', async () => {
    const { relocateDataDir } = await loadPaths();
    await expect(relocateDataDir(root, { moveExisting: true })).rejects.toThrow(/not inside/i);
  });

  it('leaves the panel on its old folder when a move is refused', async () => {
    const { paths, relocateDataDir } = await loadPaths();
    await expect(relocateDataDir(dataDir, { moveExisting: true })).rejects.toThrow();
    expect(paths().dataDir).toBe(dataDir);
  });
});

describe('remembering the move across a restart', () => {
  it('writes the folder into the panel’s own settings file', async () => {
    const { relocateDataDir } = await loadPaths();
    const target = path.join(root, 'moved');

    await relocateDataDir(target, { moveExisting: false });

    // `config.settingsFile`, not `packageRoot/.env`: under Program Files the
    // package folder is read-only, and this write is what makes the move
    // survive a restart.
    const env = await fs.readFile(path.join(root, 'office-settings.env'), 'utf8');
    expect(env).toContain(`ORDERBOOK_OFFICE_DATA_DIR=${target}`);
  });

  it('keeps that settings file outside the folder it is moving', async () => {
    const { relocateDataDir } = await loadPaths();
    const target = path.join(root, 'moved');

    await relocateDataDir(target, { moveExisting: true });

    // The subtle one. If the file recording where the data lives were kept
    // inside the data directory, moving the data would carry the pointer with
    // it — and the next start would look in the old place, find nothing, and
    // quietly begin again on an empty panel.
    await expect(fs.stat(path.join(target, 'office-settings.env'))).rejects.toThrow();
    await expect(fs.stat(path.join(root, 'office-settings.env'))).resolves.toBeTruthy();
  });
});

describe('the .env writer', () => {
  it('adds a key to a file that does not exist yet', async () => {
    const { writeEnvValue } = await import('../src/lib/env-file.js');
    const file = path.join(root, 'fresh', '.env');

    await writeEnvValue(file, 'ORDERBOOK_OFFICE_DATA_DIR', '/srv/panel');

    await expect(fs.readFile(file, 'utf8')).resolves.toBe(
      'ORDERBOOK_OFFICE_DATA_DIR=/srv/panel\n',
    );
  });

  it('replaces the line rather than appending a second one', async () => {
    const { writeEnvValue } = await import('../src/lib/env-file.js');
    const file = path.join(root, '.env');
    await fs.writeFile(file, 'OFFICE_PORT=4200\nORDERBOOK_OFFICE_DATA_DIR=/old\n');

    await writeEnvValue(file, 'ORDERBOOK_OFFICE_DATA_DIR', '/new');

    const contents = await fs.readFile(file, 'utf8');
    expect(contents).toContain('OFFICE_PORT=4200');
    expect(contents).toContain('ORDERBOOK_OFFICE_DATA_DIR=/new');
    expect(contents).not.toContain('/old');
  });

  it('quotes a path with a space, so the loader reads it back whole', async () => {
    const { writeEnvValue, loadEnvFiles } = await import('../src/lib/env-file.js');
    const file = path.join(root, '.env');
    const value = 'C:\\Program Files\\OrderBook\\data';

    await writeEnvValue(file, 'TEST_SPACED_PATH', value);
    delete process.env.TEST_SPACED_PATH;
    loadEnvFiles(file);

    expect(process.env.TEST_SPACED_PATH).toBe(value);
    delete process.env.TEST_SPACED_PATH;
  });
});
