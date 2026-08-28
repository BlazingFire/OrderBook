/**
 * The Master Panel's desktop shell.
 *
 * This is the `.exe` an operator double-clicks. It does what
 * `Launch Master Panel.bat` has always done — start the server, wait for the
 * port, open a window — but as a real application rather than a console window
 * with a browser behind it, and with three jobs a batch file could never do:
 *
 *  1. **Put the data somewhere an installer will not delete.** The server's own
 *     default is `<packageRoot>/data`, which is correct running from source and
 *     catastrophic under Program Files: read-only, and replaced wholesale by the
 *     next setup file. The shell sets `ORDERBOOK_DATA_DIR` to a per-machine
 *     location before the server starts, so the server's defaults stay exactly
 *     as they are and the dev workflow is untouched.
 *  2. **Show the boot progress.** The server opens its port before anything that
 *     can fail and reports its state at `/api/health` — a design that has had no
 *     consumer until now. First-run initdb takes the better part of a minute on
 *     a shop PC, and a blank window for a minute is indistinguishable from a
 *     broken one.
 *  3. **Run a setup file and quit.** Nothing else can: a web page has no such
 *     power, and the server cannot let an installer replace its own program
 *     files mid-request.
 *
 * **The server runs as a child process, unmodified.** Electron ships a Node
 * runtime, so `ELECTRON_RUN_AS_NODE` reuses it rather than bundling a second
 * one — and a crashed server leaves a window that can say so, instead of taking
 * the whole application down with it.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';

const PANEL = 'master' as const;
const PORT = Number(process.env.PORT ?? 4100);
const ORIGIN = `http://localhost:${PORT}`;

/** First-run builds a PostgreSQL cluster; that is the slow one to allow for. */
const READY_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 400;

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Where the server's code lives, packaged or not.
 *
 * Packaged, `extraResources` puts the whole panel beside the asar rather than
 * inside it: the server spawns as a real Node process and reads fonts, the web
 * bundle and the vendored PostgreSQL binaries as real files, none of which
 * works from inside an archive.
 */
const serverRoot = app.isPackaged
  ? path.join(process.resourcesPath, 'panel')
  : path.resolve(here, '..', '..');

let serverProcess: ChildProcess | null = null;
let mainWindow: BrowserWindow | null = null;
/** Set when we are deliberately replacing ourselves, so the exit is not an error. */
let updating = false;
/** Set once a quit is under way, so the server's exit is expected rather than a crash. */
let quitting = false;

/**
 * Per-machine, outside the program folder, and **not** inside the app's own
 * `userData` — an operator who has to find, copy or back this up should not be
 * hunting through an Electron cache directory for their company's database.
 */
function dataDir(): string {
  return path.join(app.getPath('appData'), 'OrderBook', PANEL);
}

function startServer(): ChildProcess {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Reuse Electron's own Node rather than shipping a second runtime.
    ELECTRON_RUN_AS_NODE: '1',
    ORDERBOOK_DATA_DIR: dataDir(),
    PORT: String(PORT),
  };

  /*
   * A packaged Master uses its own bundled database, full stop.
   *
   * `DATABASE_URL` points the server at an external PostgreSQL, and the child
   * inherits this process's environment — so launching the app from a terminal
   * that happened to have one set silently pointed the installed application at
   * a developer's database. That is not theoretical: it happened, and the
   * symptom was the Master refusing to boot because *that* database's migration
   * history did not match the build's.
   *
   * A deliberate override still works, and has an obvious home: a `.env` beside
   * the installed application, which `loadEnvFiles` reads. What is removed is
   * the accident of inheriting one.
   */
  if (app.isPackaged) delete env.DATABASE_URL;

  const child = spawn(process.execPath, [path.join(serverRoot, 'dist', 'index.js')], {
    cwd: serverRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Forwarded rather than swallowed: when a shop PC will not start, the log is
  // the only thing anybody has to go on.
  child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(chunk));
  child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk));

  child.on('exit', (code) => {
    if (updating || quitting) return;

    dialog.showErrorBox(
      'OrderBook stopped',
      `The Master Panel server stopped unexpectedly (exit code ${code ?? 'unknown'}).\n\n` +
        'Close this window and start OrderBook again. If it keeps happening, the log ' +
        `is in ${dataDir()}.`,
    );
    app.quit();
  });

  return child;
}

/**
 * Wait for the server to answer, not for a fixed delay.
 *
 * `/api/health` answers from the moment the port is open — `{ status:
 * 'starting', boot }` while the cluster is being built, `{ status: 'ok' }` once
 * it is usable — so this can show real progress rather than a guess.
 */
async function waitForServer(onStep: (step: string) => void): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${ORIGIN}/api/health`, {
        signal: AbortSignal.timeout(POLL_INTERVAL_MS * 2),
      });
      const body = (await response.json()) as {
        status?: string;
        boot?: { state?: string; step?: string };
      };

      if (body.status === 'ok') return true;
      // A boot failure is terminal: the server deliberately stays up serving its
      // own error page, so hand the window over and let it explain.
      if (body.boot?.state === 'failed') return true;
      if (body.boot?.step) onStep(body.boot.step);
    } catch {
      // Not listening yet. Normal for the first second or two.
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  return false;
}

function splashHtml(message: string): string {
  // Inline, because the window has to exist before the server does — there is
  // nothing to load a page from yet.
  return `data:text/html;charset=utf-8,${encodeURIComponent(`
    <html><body style="margin:0;display:flex;align-items:center;justify-content:center;
      height:100vh;background:#111318;color:#e7e9ee;
      font:14px/1.5 'Segoe UI',system-ui,sans-serif">
      <div style="text-align:center">
        <div style="font-size:18px;font-weight:600;margin-bottom:8px">OrderBook Master Panel</div>
        <div style="opacity:.7">${message}</div>
      </div>
    </body></html>`)}`;
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1366,
    minHeight: 768,
    backgroundColor: '#111318',
    show: true,
    title: 'OrderBook — Master Panel',
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  await mainWindow.loadURL(splashHtml('Starting…'));

  const ready = await waitForServer((step) => {
    void mainWindow?.loadURL(splashHtml(step));
  });

  if (!ready) {
    await mainWindow.loadURL(
      splashHtml('The server did not start in time. Close this window and try again.'),
    );
    return;
  }

  await mainWindow.loadURL(ORIGIN);

  // Anything that is not this panel opens in the real browser, never in here —
  // a window with no address bar is no place to land on an unexpected page.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(ORIGIN)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function buildMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: '&File',
        submenu: [{ role: 'quit' }],
      },
      {
        label: '&View',
        submenu: [{ role: 'reload' }, { role: 'togglefullscreen' }, { role: 'toggleDevTools' }],
      },
      {
        label: '&Help',
        submenu: [
          {
            label: 'Check for updates',
            // Navigates rather than checking anything itself: the Updates screen
            // is where this lives, and two places that answer the same question
            // is one place too many.
            click: () => void mainWindow?.loadURL(`${ORIGIN}/#/updates`),
          },
          {
            label: `Version ${app.getVersion()}`,
            enabled: false,
          },
        ],
      },
    ]),
  );
}

/**
 * Run a verified setup file and quit.
 *
 * The renderer has already downloaded and checksummed it. This only launches
 * it, detached, and gets out of the way — an installer cannot replace files a
 * running process holds open.
 */
ipcMain.handle('orderbook:applyUpdate', (_event, filePath: unknown): boolean => {
  if (typeof filePath !== 'string' || !filePath.toLowerCase().endsWith('.exe')) return false;

  try {
    updating = true;
    const child = spawn(filePath, [], { detached: true, stdio: 'ignore' });
    child.unref();

    // Give the installer a moment to take hold before this process — and the
    // server it owns — release the files it is about to replace.
    setTimeout(() => app.quit(), 1_000);
    return true;
  } catch {
    updating = false;
    return false;
  }
});

/*
 * Name this application before anything asks Electron where its files go.
 *
 * `requestSingleInstanceLock` is keyed on `userData`, which Electron derives
 * from the application name. Packaged, that name comes from `productName` in
 * `electron-builder.yml` and the two panels differ. Run from source there is no
 * `productName`, so both panels are called `Electron`, share one `userData`
 * directory, and therefore share one lock — whichever panel started second took
 * the failed branch below and quit instantly, with no window, no dialog and
 * nothing in any log. Naming it here makes the development and packaged cases
 * behave identically.
 */
app.setName('OrderBook Master Panel');

// One instance only. A second copy would fail to bind the port and leave the
// operator looking at two windows, one of them permanently on the splash.
if (!app.requestSingleInstanceLock()) {
  // Say so. A silent exit is indistinguishable from a crash, and this is the
  // single most likely thing to happen to an operator who double-clicks twice.
  dialog.showErrorBox(
    'OrderBook Master Panel is already running',
    'Only one copy can run at a time. Switch to the window that is already open.',
  );
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(async () => {
    // The Master is the machine every panel syncs through, so it comes up with
    // the PC rather than waiting for somebody to click something. Without this,
    // nobody opening OrderBook in the morning means every panel sits offline.
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true });

    serverProcess = startServer();
    buildMenu();
    await createWindow();
  });

  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', () => {
    quitting = true;
    // SIGTERM, not kill: `installShutdownHandlers` closes the database cluster
    // and the sockets properly, and a half-closed PostgreSQL cluster is the one
    // thing here that costs real time to recover from.
    serverProcess?.kill('SIGTERM');
  });
}
