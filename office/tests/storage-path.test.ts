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

// The desktop shell's own reader and writer for its pointer file, and the
// environment it starts this server with — imported rather than re-implemented:
// the point of the tests that use them is that the panel writes a file *the
// shell* reads back, in the shell's format, having been told where by the shell.
import { officeServerEnv } from '../../electron/lib/office-env.js';
import { readDataDirOverride, writeDataDirOverride } from '../../electron/lib/settings.js';

let dataDir: string;
let root: string;
/** Everything in the environment before a test, so a simulated restart cannot leak. */
let environmentBefore: NodeJS.ProcessEnv;

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
async function loadPaths(options: { underShell?: boolean } = {}) {
  vi.doMock('../src/config/index.js', () => ({
    config: {
      dataDir,
      packageRoot: root,
      // Beside the data directory, never inside it — this is the file that
      // records *where* the data directory is, so a move must not carry it
      // along and leave the next start looking in the old place.
      settingsFile: path.join(root, 'office-settings.env'),
      // Set only when the desktop shell started this process — see
      // `ORDERBOOK_OFFICE_LOCATION_FILE` in `config/index.ts`.
      locationFile: options.underShell ? locationFile() : null,
      http: { port: 4200 },
      hostname: 'test-pc',
    },
  }));

  const paths = await import('../src/config/paths.js');
  paths.resetPathsForTest();
  return paths;
}

/** Where the shell keeps `office-location.json`: beside the panel folders, not in one. */
function locationFile(): string {
  return path.join(root, 'office-location.json');
}

/**
 * Start this panel the way whoever launches it would, and hand back its
 * storage module.
 *
 * Nothing is mocked: the real `config/index.ts` resolves the folder from the
 * environment and the settings file, exactly as it does on a real start, and
 * `paths()` answers from that.
 *
 * Under the shell, the environment is what `electron/shell.ts` builds before
 * every start of the server — `dataDir()` there is the pointer file if it names
 * a folder and the default otherwise, and `officeServerEnv` hands that over as
 * `ORDERBOOK_OFFICE_DATA_DIR`, with the pointer's own path beside it. The folder
 * the panel was first started in stands in for the shell's default. From
 * source nothing sets the folder at all, and the settings file is what the
 * start reads.
 *
 * The settings file is set to a temporary one first, whatever the launcher: the
 * real default is `office/.env` in this repository, a file no test may write,
 * and a shell environment that forgot to name one would otherwise send a move
 * there.
 */
async function start(launcher: 'shell' | 'source') {
  delete process.env.ORDERBOOK_OFFICE_DATA_DIR;
  delete process.env.ORDERBOOK_OFFICE_LOCATION_FILE;
  process.env.ORDERBOOK_OFFICE_SETTINGS_FILE = path.join(root, 'office-settings.env');

  if (launcher === 'shell') {
    Object.assign(
      process.env,
      officeServerEnv({
        dataDir: readDataDirOverride(locationFile()) ?? dataDir,
        port: 4200,
        logFile: path.join(root, 'office.log'),
        locationFile: locationFile(),
      }),
    );
  }

  vi.doUnmock('../src/config/index.js');
  vi.resetModules();
  return import('../src/config/paths.js');
}

/** Stop this panel and start it again, and say which folder it came back up in. */
async function restart(launcher: 'shell' | 'source'): Promise<string> {
  const { paths } = await start(launcher);
  return paths().dataDir;
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
  environmentBefore = { ...process.env };

  vi.resetModules();
});

afterEach(async () => {
  vi.doUnmock('../src/config/index.js');
  for (const key of Object.keys(process.env)) {
    if (!(key in environmentBefore)) delete process.env[key];
  }
  Object.assign(process.env, environmentBefore);
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

    // The mode bits are asserted on POSIX only, and that is not a gap being
    // waved away — it is that Windows has no POSIX mode to assert. Node's
    // `chmod` there toggles the read-only attribute and nothing else, and
    // `stat().mode` answers a synthesised `0o666`, so `mode & 0o077` is `0o066`
    // on a file that is in fact protected by the folder's inherited ACL. This
    // assertion ran red on every Windows run for exactly that reason, which is
    // worse than not running: a permanently-failing test stops being read.
    // What Windows *can* be held to is that the copy happened at all.
    if (process.platform === 'win32') {
      expect(stats.isFile()).toBe(true);
    } else {
      expect(stats.mode & 0o077).toBe(0);
    }
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

/*
 * The folders a move must never make this panel's.
 *
 * Whatever folder a move lands in is recorded in the shell's pointer, and
 * "Uninstall, delete data" deletes the folder that pointer names, whole
 * (`tools/uninstall/`). So a move into `D:\`, somebody's home folder or their
 * Documents would one day take everything else in it along with the panel.
 */
describe('refusing a folder the panel would not own', () => {
  it('refuses the top of a drive', async () => {
    writeDataDirOverride(locationFile(), dataDir);
    const { paths, relocateDataDir } = await loadPaths({ underShell: true });

    // On one machine this is `/`; the case that matters is `D:\` with the data
    // on `C:`, which the nesting rule does not catch. Refused for its own
    // reason first, so both read the same.
    await expect(relocateDataDir(path.parse(root).root, { moveExisting: true })).rejects.toThrow(
      /top of a drive/i,
    );

    expect(paths().dataDir).toBe(dataDir);
    expect(readDataDirOverride(locationFile())).toBe(dataDir);
  });

  it('refuses the home folder of whoever runs it', async () => {
    // Not the real one: a move that was wrongly let through would copy the
    // panel's files into it.
    const home = path.join(root, 'home');
    await fs.mkdir(home);
    const homedir = vi.spyOn(os, 'homedir').mockReturnValue(home);
    writeDataDirOverride(locationFile(), dataDir);
    const { relocateDataDir } = await loadPaths({ underShell: true });
    await seedDataDir();

    try {
      await expect(relocateDataDir(home, { moveExisting: true })).rejects.toThrow(/home folder/i);
    } finally {
      homedir.mockRestore();
    }

    await expect(fs.readdir(home)).resolves.toEqual([]);
    expect(readDataDirOverride(locationFile())).toBe(dataDir);
  });

  it('refuses a folder that already holds somebody else’s files, and copies nothing into it', async () => {
    const target = path.join(root, 'documents');
    await fs.mkdir(path.join(target, 'Photos'), { recursive: true });
    await fs.writeFile(path.join(target, 'Budget.xlsx'), 'the accounts');
    writeDataDirOverride(locationFile(), dataDir);
    const { paths, relocateDataDir } = await loadPaths({ underShell: true });
    await seedDataDir();

    // Named, because the person reading this is at the Master and cannot see
    // the folder: "not empty" alone would leave them guessing what is in it.
    await expect(relocateDataDir(target, { moveExisting: true })).rejects.toThrow(/Budget\.xlsx/);

    expect((await fs.readdir(target)).sort()).toEqual(['Budget.xlsx', 'Photos']);
    expect(paths().dataDir).toBe(dataDir);
    expect(readDataDirOverride(locationFile())).toBe(dataDir);
  });

  it('takes an empty folder that already exists', async () => {
    const target = path.join(root, 'empty');
    await fs.mkdir(target);
    const { relocateDataDir } = await loadPaths({ underShell: true });

    await expect(relocateDataDir(target, { moveExisting: true })).resolves.toMatchObject({
      dataDir: target,
    });
  });

  it('takes a folder holding nothing but an Office Panel’s own files', async () => {
    // A folder this panel moved away from earlier, which keeps its old copy —
    // a queue it once set aside as unreadable included — and the shell's log
    // and setting, with the litter Finder and Explorer leave behind in any
    // folder somebody has opened.
    const target = path.join(root, 'earlier');
    await fs.mkdir(path.join(target, 'images', 'IM1'), { recursive: true });
    await fs.mkdir(path.join(target, 'logs'));
    await fs.writeFile(path.join(target, 'logs', 'office.log'), 'old lines');
    for (const name of [
      'outbox.json',
      'outbox.json.tmp',
      'outbox.json.unreadable-2026-09-25T09-30-00-000Z',
      'pairing.json',
      'shell.json',
      '.DS_Store',
    ]) {
      await fs.writeFile(path.join(target, name), '[]');
    }
    const { relocateDataDir } = await loadPaths({ underShell: true });
    await seedDataDir();

    await expect(relocateDataDir(target, { moveExisting: true })).resolves.toMatchObject({
      dataDir: target,
    });
    expect(readDataDirOverride(locationFile())).toBe(target);
  });
});

describe('remembering the move across a restart', () => {
  it('writes the folder into the panel’s own settings file when run from source', async () => {
    const { relocateDataDir } = await loadPaths();
    const target = path.join(root, 'moved');

    await relocateDataDir(target, { moveExisting: false });

    // From source nothing puts the folder into the environment, so this file
    // is what the next start reads it from.
    const env = await fs.readFile(path.join(root, 'office-settings.env'), 'utf8');
    expect(env).toContain(`ORDERBOOK_OFFICE_DATA_DIR=${target}`);
  });

  it('comes back up in the new folder when run from source', async () => {
    const { relocateDataDir } = await loadPaths();
    await seedDataDir();
    const target = path.join(root, 'moved');

    await relocateDataDir(target, { moveExisting: true });

    await expect(restart('source')).resolves.toBe(target);
  });

  it('rewrites the desktop shell’s own pointer, in the shell’s format', async () => {
    // What the shell's first-run folder chooser leaves behind.
    writeDataDirOverride(locationFile(), dataDir);
    const { relocateDataDir } = await loadPaths({ underShell: true });
    const target = path.join(root, 'moved');

    await relocateDataDir(target, { moveExisting: false });

    expect(readDataDirOverride(locationFile())).toBe(target);
    // Written aside and renamed over, so the shell never reads half a file.
    await expect(fs.stat(`${locationFile()}.tmp`)).rejects.toThrow();
  });

  it('comes back up in the new folder under the desktop shell', async () => {
    const { relocateDataDir } = await loadPaths({ underShell: true });
    await seedDataDir();
    const target = path.join(root, 'moved');

    await relocateDataDir(target, { moveExisting: true });

    // The defect this pins. The shell puts the folder into the server's real
    // environment before every start, and `loadEnvFiles` never overrides a
    // real variable — so a move recorded only in the settings file was read,
    // discarded, and the panel came back up in the folder it had just left,
    // with everything saved since the move stranded at the new one.
    await expect(restart('shell')).resolves.toBe(target);
  });

  it('follows a move made by a panel the shell itself started', async () => {
    // No mocked config at all this time: the pointer's path reaches the move
    // only through the environment the shell starts the server with.
    const { relocateDataDir } = await start('shell');
    await seedDataDir();
    const target = path.join(root, 'moved');

    await relocateDataDir(target, { moveExisting: true });

    expect(readDataDirOverride(locationFile())).toBe(target);
    await expect(restart('shell')).resolves.toBe(target);
  });

  it('leaves the pointer alone when a move is refused', async () => {
    writeDataDirOverride(locationFile(), dataDir);
    const { relocateDataDir } = await loadPaths({ underShell: true });

    await expect(
      relocateDataDir(path.join(dataDir, 'nested'), { moveExisting: true }),
    ).rejects.toThrow();

    expect(readDataDirOverride(locationFile())).toBe(dataDir);
    await expect(restart('shell')).resolves.toBe(dataDir);
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
