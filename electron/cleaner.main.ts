/**
 * OrderBook Clean Install — the standalone tool's desktop entrypoint.
 *
 * Not a panel. It shares no code with `shell.ts`, which exists to supervise a
 * Node server, open a window on it and keep the two alive; this starts no
 * server and owns no data. What it shares is the part that matters: the two
 * scripts under `tools/uninstall/`, and the command lines `lib/uninstall.ts`
 * builds for them.
 *
 * ## Why this exists as its own program
 *
 * The sweep already shipped, inside both setup files as `resources/uninstall`,
 * and the app's Settings → Developer → Uninstall runs it. But the machine that
 * needs it is the one where the install is broken enough that nothing starts —
 * so the tool was locked inside the thing it was meant to rescue. This is the
 * same scripts, reachable from a USB stick.
 *
 * ## The order, and why
 *
 * Detect → back up → confirm → wipe → verify → install. The verify pass is the
 * step the NSIS uninstaller cannot do: it re-runs detection after the sweep and
 * reports what is still there, rather than reporting success because a script
 * exited zero.
 *
 * Every step that can destroy something is behind an IPC handler that
 * validates its own arguments. The page is a static file with no framework,
 * but it is still a renderer, and a renderer asking to delete a folder is a
 * renderer that must not be taken at its word.
 */

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron';

import { sweepCommand } from './lib/uninstall.js';
import { planBackup, runBackup, isSafeDestination } from './lib/cleaner/backup.js';
import { dataFolders, parseScriptOutput, present } from './lib/cleaner/detect.js';
import { manifestNames, panelOf, verifySetupFile } from './lib/cleaner/setup-file.js';
import { runScript } from './lib/cleaner/run.js';

const PRODUCT = 'OrderBook Clean Install';

app.setName(PRODUCT);

let window: BrowserWindow | null = null;

/** Where `tools/uninstall` ends up: beside us packaged, in the repo otherwise. */
function scriptsDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'uninstall')
    : path.resolve(import.meta.dirname, '..', '..', 'tools', 'uninstall');
}

/** Send a line to the page's log pane, if there is still a page. */
function emit(channel: string, payload: unknown): void {
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
}

/**
 * Run the sweep, dry or real, and hand back what it said.
 *
 * One function for both because the verify pass is a detect pass: a second
 * code path for "check again afterwards" could disagree with the first about
 * what counts as present, in the step whose only job is to be believed.
 */
async function sweep(dryRun: boolean): Promise<ReturnType<typeof parseScriptOutput>> {
  const command = sweepCommand({
    platform: process.platform,
    panel: 'all',
    dryRun,
    scriptsDir: scriptsDir(),
  });

  if (!command) {
    throw new Error(`No uninstall script ships for ${process.platform}.`);
  }

  const run = await runScript(command, (line) => emit('cleaner:line', line));
  return parseScriptOutput(run.stdout);
}

ipcMain.handle('cleaner:detect', async () => {
  const report = await sweep(true);
  return {
    findings: present(report),
    notes: report.notes,
    dataFolders: dataFolders(report).map((finding) => finding.path),
    platform: process.platform,
  };
});

ipcMain.handle('cleaner:chooseBackupFolder', async () => {
  const chosen = await dialog.showOpenDialog({
    title: 'Where should the copy go?',
    properties: ['openDirectory', 'createDirectory'],
  });
  return chosen.canceled ? null : (chosen.filePaths[0] ?? null);
});

ipcMain.handle('cleaner:backup', async (_event, request: unknown) => {
  const { into, sources } = request as { into?: unknown; sources?: unknown };
  if (typeof into !== 'string' || !Array.isArray(sources)) {
    throw new Error('A backup needs a destination and a list of folders.');
  }
  const from = sources.filter((source): source is string => typeof source === 'string');

  // Checked here, not only in the page: a backup written inside a folder the
  // sweep is about to remove would go with it, and the report would say it
  // had succeeded.
  if (!isSafeDestination(into, from)) {
    throw new Error('That folder is inside one of the folders being erased. Choose another.');
  }

  return runBackup(planBackup(from, into));
});

ipcMain.handle('cleaner:wipe', async (_event, request: unknown) => {
  const { confirmation } = request as { confirmation?: unknown };

  /*
   * The typed word, checked in the main process.
   *
   * The page asks for it too, and that is the part a person sees — but a
   * renderer can be made to say anything, and this handler erases a company's
   * database. The same shape `master/src/http/routes/developer.routes.ts` uses
   * for its own reset: the confirmation is a parameter, not a state the client
   * claims to be in.
   */
  if (confirmation !== 'DELETE') {
    throw new Error('The confirmation word was not given.');
  }

  const report = await sweep(false);
  return { failures: report.failures, counts: report.counts };
});

ipcMain.handle('cleaner:verify', async () => {
  const report = await sweep(true);
  return { leftovers: present(report) };
});

ipcMain.handle('cleaner:chooseSetupFile', async () => {
  const filters = [
    { name: 'OrderBook setup', extensions: ['exe', 'dmg', 'AppImage', 'deb'] },
    { name: 'All files', extensions: ['*'] },
  ];
  const chosen = await dialog.showOpenDialog({ title: 'Choose the setup file', filters });
  return chosen.canceled ? null : (chosen.filePaths[0] ?? null);
});

/** Read the manifest the release script writes beside a published setup file. */
async function manifestBeside(setupPath: string): Promise<unknown> {
  for (const name of manifestNames(process.platform)) {
    try {
      const raw = await readFile(path.join(path.dirname(setupPath), name), 'utf8');
      return JSON.parse(raw);
    } catch {
      // Absent or unreadable: try the next name, then answer "no manifest".
    }
  }
  return null;
}

/** SHA-256 of the bytes on disk, streamed — these files are ~160 MB. */
async function hashOf(file: string): Promise<string> {
  const { createReadStream } = await import('node:fs');
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

ipcMain.handle('cleaner:checkSetupFile', async (_event, request: unknown) => {
  const { setupPath } = request as { setupPath?: unknown };
  if (typeof setupPath !== 'string' || setupPath === '') {
    throw new Error('No setup file was chosen.');
  }

  const info = await stat(setupPath);
  const manifest = (await manifestBeside(setupPath)) as Parameters<
    typeof verifySetupFile
  >[0]['manifest'];

  // Cheap facts first. The hash is only worth 160 MB of reading once the name,
  // the platform and the size already agree.
  const cheap = verifySetupFile({
    fileName: path.basename(setupPath),
    sizeBytes: info.size,
    sha256: null,
    manifest,
    platform: process.platform,
  });
  if (!cheap.ok || !manifest) {
    return { verdict: cheap, panel: panelOf(path.basename(setupPath)) };
  }

  emit('cleaner:line', `[check] hashing ${path.basename(setupPath)}…`);
  const verdict = verifySetupFile({
    fileName: path.basename(setupPath),
    sizeBytes: info.size,
    sha256: await hashOf(setupPath),
    manifest,
    platform: process.platform,
  });

  return { verdict, panel: panelOf(path.basename(setupPath)) };
});

ipcMain.handle('cleaner:install', async (_event, request: unknown) => {
  const { setupPath, accepted } = request as { setupPath?: unknown; accepted?: unknown };
  if (typeof setupPath !== 'string' || setupPath === '') {
    throw new Error('No setup file was chosen.');
  }
  // `accepted` is how the page says somebody agreed to run a file nothing
  // vouches for. A missing or mistyped field must not quietly mean yes.
  if (accepted !== true) {
    throw new Error('The setup file was not accepted.');
  }

  if (process.platform === 'win32') {
    // Detached, and we quit: the installer replaces files and wants the
    // machine to itself. Same shape `shell.ts` uses to hand over to an update.
    spawn(setupPath, [], { detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'darwin') {
    // A .dmg is opened, not executed — mounting it and dragging the app across
    // is the Mac install, and doing that silently would be a surprise.
    await shell.openPath(setupPath);
  } else {
    spawn(setupPath, [], { detached: true, stdio: 'ignore' }).unref();
  }

  return { started: true };
});

function createWindow(): void {
  window = new BrowserWindow({
    width: 960,
    height: 760,
    minWidth: 720,
    minHeight: 560,
    title: PRODUCT,
    backgroundColor: '#111318',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(import.meta.dirname, 'cleaner.preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      devTools: !app.isPackaged,
    },
  });

  // Nothing in this tool navigates anywhere. Refusing up front means a future
  // link in the page cannot turn a privileged window into a browser.
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  void window.loadFile(
    app.isPackaged
      ? path.join(process.resourcesPath, 'web', 'index.html')
      : path.resolve(import.meta.dirname, '..', '..', 'cleaner', 'web', 'index.html'),
  );
}

// One at a time. Two copies sweeping the same PC would race each other's
// deletions and report each other's leftovers.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });

  void app.whenReady().then(createWindow);
  app.on('window-all-closed', () => app.quit());
}
