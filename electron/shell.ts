/**
 * The desktop shell both panels run in.
 *
 * This was two ~300-line files that differed by a port, a data directory,
 * three product-name strings and one auto-start branch — so every fix had to
 * be made twice, and in practice was not: the two drifted, and the Office copy
 * spent sixty seconds polling a route its server did not have.
 *
 * What the shell is for, beyond hosting a window:
 *
 *  1. **Put the data somewhere an installer will not delete.** The server's own
 *     default is `<packageRoot>/data`, which is correct from source and
 *     catastrophic under Program Files: read-only, and replaced wholesale by
 *     the next setup file.
 *  2. **Show the boot progress.** First-run `initdb` takes the better part of a
 *     minute on a shop PC, and a blank window for a minute is
 *     indistinguishable from a broken one.
 *  3. **Run a setup file and quit.** Nothing else can: a web page has no such
 *     power, and the server cannot let an installer replace the files it is
 *     running from mid-request.
 *  4. **Keep the server alive, and say so when it dies.** See `lib/supervisor`.
 *
 * The server runs as a child process, unmodified. Electron ships a Node
 * runtime, so `ELECTRON_RUN_AS_NODE` reuses it rather than bundling a second
 * one — and a crashed server leaves a window that can explain itself, instead
 * of taking the whole application down.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';

import { app, BrowserWindow, dialog, ipcMain, Menu, shell as electronShell } from 'electron';

import { interpretHealth, type HealthOutcome } from './lib/health.js';
import { approveInstaller, installerExtension } from './lib/installer.js';
import { openLogFile, type LogFile } from './lib/log-file.js';
import {
  readDataDirOverride,
  readShellSettings,
  writeDataDirOverride,
  writeShellSettings,
} from './lib/settings.js';
import { canRestart, isExpectedExit, pruneRestarts, RESTART_LIMIT } from './lib/supervisor.js';

export interface PanelShellConfig {
  readonly panel: 'master' | 'office';
  /** Must match `productName` in the panel's electron-builder.yml. */
  readonly productName: string;
  readonly port: number;
  /** Master builds a PostgreSQL cluster on first run; that is the slow one. */
  readonly readyTimeoutMs: number;
  readonly autoStartByDefault: boolean;
  /**
   * Environment **overrides only** — the shell spreads `process.env`
   * underneath. Returning a bare object here would hand the child no
   * `SystemRoot`, `PATH` or `TEMP`, and `initdb` would not run.
   */
  serverEnv(context: { dataDir: string; port: number; logFile: string }): NodeJS.ProcessEnv;
}

const POLL_INTERVAL_MS = 400;
const STOP_GRACE_MS = 10_000;

export function runPanelShell(config: PanelShellConfig): void {
  const ORIGIN = `http://localhost:${config.port}`;
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

  let serverProcess: ChildProcess | null = null;
  let mainWindow: BrowserWindow | null = null;
  let log: LogFile | null = null;
  let quitting = false;
  /** Set while `orderbook:setDataDir` stops the server on purpose. */
  let relocating = false;
  let draining = false;
  let updatingSince: number | null = null;
  let restarts: number[] = [];
  /** Learned from the panel's own loopback health route, never from the page. */
  let installerDir: string | null = null;

  /**
   * Per-machine, outside the program folder, and **not** inside the app's own
   * `userData` — an operator who has to find, copy or back this up should not
   * be hunting through an Electron cache directory for their company's
   * database.
   */
  /**
   * Where the panel's own folder sits, unless the operator moved it.
   *
   * Read fresh rather than captured, because a first-run relocation rewrites
   * the pointer and restarts the server underneath us — a value snapshotted at
   * launch would send the restarted child back to the old folder.
   */
  const defaultDataDir = (): string => path.join(app.getPath('appData'), 'OrderBook', config.panel);
  const locationPath = (): string =>
    path.join(app.getPath('appData'), 'OrderBook', `${config.panel}-location.json`);
  const dataDir = (): string => readDataDirOverride(locationPath()) ?? defaultDataDir();
  const logPath = (): string => path.join(dataDir(), 'logs', `${config.panel}.log`);
  const settingsPath = (): string => path.join(dataDir(), 'shell.json');

  const say = (line: string): void => {
    log?.write(`INFO  [shell] ${line}`);
  };

  /**
   * Where the server's code lives, packaged or not.
   *
   * Packaged, `extraResources` puts the whole panel beside the asar rather
   * than inside it: the server spawns as a real Node process and reads fonts,
   * the web bundle and the vendored PostgreSQL binaries as real files, none of
   * which works from inside an archive.
   */
  const serverRoot = (): string =>
    app.isPackaged
      ? path.join(process.resourcesPath, 'panel')
      : // The built shell is copied into `<panel>/electron/dist` by
        // `npm run build:shell`, so the panel root is two levels up. Run it
        // from anywhere else and it will not find the server.
        path.resolve(here, '..', '..');

  function startServer(): ChildProcess {
    const totalRamMb = Math.round(os.totalmem() / (1024 * 1024));
    // Office gets 40% of total RAM; Master gets up to 60%.
    const ramCapMb =
      config.panel === 'office' ? Math.round(totalRamMb * 0.4) : Math.round(totalRamMb * 0.6);
    // 70% of the cap for the heap, the rest for Postgres buffers and overhead.
    const maxOldSpaceMb = Math.round(ramCapMb * 0.7);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // Reuse Electron's own Node rather than shipping a second runtime.
      ELECTRON_RUN_AS_NODE: '1',
      NODE_OPTIONS: `--max-old-space-size=${maxOldSpaceMb}`,
      ORDERBOOK_PANEL: config.panel,
      ORDERBOOK_RAM_CAP_MB: String(ramCapMb),
      ...config.serverEnv({ dataDir: dataDir(), port: config.port, logFile: logPath() }),
    };

    /*
     * A packaged panel uses its own bundled database, full stop.
     *
     * `DATABASE_URL` points the server at an external PostgreSQL, and the
     * child inherits this process's environment — so launching the app from a
     * terminal that happened to have one set silently pointed the installed
     * application at a developer's database. That is not theoretical: it
     * happened, and the symptom was the Master refusing to boot because that
     * database's migration history did not match the build's. A deliberate
     * override still works through a `.env` beside the installed application.
     */
    if (app.isPackaged) delete env.DATABASE_URL;

    const child = spawn(process.execPath, [path.join(serverRoot(), 'dist', 'index.js')], {
      cwd: serverRoot(),
      env,
      // The fourth slot is the point: Windows has no signals, so a graceful
      // stop has to be a message the child can actually observe.
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    child.stdout?.on('data', (chunk: Buffer) => log?.writeRaw(chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => log?.writeRaw(chunk.toString()));
    child.on('exit', (code) => void onServerExit(code));

    return child;
  }

  async function onServerExit(code: number | null): Promise<void> {
    if (isExpectedExit({ quitting, relocating, updatingSince, now: Date.now() })) return;

    say(`Server exited unexpectedly (code ${code ?? 'unknown'})`);
    restarts = pruneRestarts(restarts, Date.now());

    if (canRestart(restarts, Date.now())) {
      restarts.push(Date.now());
      say(`Restarting the server (${restarts.length}/${RESTART_LIMIT})`);
      serverProcess = startServer();
      await showSplash('Restarting…');
      void waitForServerThenShow();
      return;
    }

    const choice = await dialog.showMessageBox({
      type: 'error',
      buttons: ['Restart', 'Open log folder', 'Quit'],
      defaultId: 0,
      cancelId: 2,
      title: 'OrderBook stopped',
      message: `The ${config.productName} server keeps stopping.`,
      detail: `It has stopped ${RESTART_LIMIT} times in a few minutes, so it has not been restarted again.\n\nThe log is at ${logPath()}.`,
    });

    if (choice.response === 0) {
      restarts = [];
      serverProcess = startServer();
      await showSplash('Restarting…');
      void waitForServerThenShow();
      return;
    }
    if (choice.response === 1) electronShell.showItemInFolder(logPath());
    app.quit();
  }

  /**
   * Ask the server to stop, wait for it, and only then give up and kill it.
   *
   * `child.kill('SIGTERM')` on Windows is `TerminateProcess` — the signal name
   * is ignored and the process cannot observe it — so the server's shutdown
   * handlers had never once run on the operator's actual machine, and every
   * quit left the PostgreSQL cluster to recover on next boot.
   *
   * The hard-kill path still leaves `postgres.exe` behind, because `pg_ctl`
   * starts the postmaster detached. That is survivable: `startCluster` returns
   * early when the cluster is already running, so the next launch adopts the
   * orphan rather than failing on it.
   *
   * Do **not** "fix" that with `taskkill /IM postgres.exe`. Plenty of these
   * machines run an unrelated PostgreSQL of their own, and killing by image
   * name would take a company database down to tidy up after ourselves. The
   * orphan only matters when an installer wants to replace the binary it is
   * running from, and the update path avoids that by taking the graceful route
   * and waiting for it.
   */
  async function stopServer(): Promise<void> {
    const child = serverProcess;
    if (!child || child.exitCode !== null) return;

    if (child.connected) {
      try {
        child.send({ type: 'orderbook:shutdown' });
      } catch {
        child.kill();
      }
    } else {
      child.kill();
    }

    const timer = setTimeout(() => child.kill(), STOP_GRACE_MS);
    try {
      await once(child, 'exit');
    } catch {
      // Already gone.
    } finally {
      clearTimeout(timer);
    }
  }

  async function pollHealth(): Promise<HealthOutcome> {
    try {
      const response = await fetch(`${ORIGIN}/api/health`, {
        signal: AbortSignal.timeout(POLL_INTERVAL_MS * 2),
      });
      const body: unknown = await response.json();
      return interpretHealth(body, config.panel);
    } catch {
      return { kind: 'not-listening' };
    }
  }

  async function waitForServer(onStep: (step: string) => void): Promise<HealthOutcome> {
    const deadline = Date.now() + config.readyTimeoutMs;

    while (Date.now() < deadline) {
      const outcome = await pollHealth();

      if (outcome.kind === 'ready') {
        installerDir = outcome.health.installerDir ?? null;
        return outcome;
      }
      // A boot failure is terminal, but the panel deliberately stays up serving
      // its own error page — so hand it the window and let it explain.
      if (outcome.kind === 'failed' || outcome.kind === 'wrong-app') return outcome;
      if (outcome.kind === 'starting') onStep(outcome.step);

      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    return { kind: 'not-listening' };
  }

  function splashHtml(message: string): string {
    // Inline, because the window has to exist before the server does — there is
    // nothing to load a page from yet. Escaped, because the boot step is now
    // server-supplied text rather than one of a handful of fixed strings.
    const safe = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `data:text/html;charset=utf-8,${encodeURIComponent(`
      <html><body style="margin:0;display:flex;align-items:center;justify-content:center;
        height:100vh;background:#111318;color:#e7e9ee;
        font:14px/1.5 'Segoe UI',system-ui,sans-serif">
        <div style="text-align:center">
          <div style="font-size:18px;font-weight:600;margin-bottom:8px">${config.productName}</div>
          <div style="opacity:.7">${safe}</div>
        </div>
      </body></html>`)}`;
  }

  async function showSplash(message: string): Promise<void> {
    try {
      await mainWindow?.loadURL(splashHtml(message));
    } catch (error) {
      say(`Could not show the splash: ${String(error)}`);
    }
  }

  async function showPanel(): Promise<void> {
    try {
      await mainWindow?.loadURL(ORIGIN);
    } catch (error) {
      say(`Could not load the panel: ${String(error)}`);
      await showSplash('The panel could not be loaded. Check the log and restart.');
    }
  }

  /** Same-origin, and not `startsWith` — that accepts `localhost:4100.evil`. */
  const sameOrigin = (url: string): boolean => url === ORIGIN || url.startsWith(`${ORIGIN}/`);

  async function waitForServerThenShow(): Promise<void> {
    const outcome = await waitForServer((step) => void showSplash(step));

    if (outcome.kind === 'ready' || outcome.kind === 'failed') {
      await showPanel();
      return;
    }
    if (outcome.kind === 'wrong-app') {
      await showSplash(
        `Another OrderBook panel (${outcome.panel}) is already using port ${config.port}. Close it and start this one again.`,
      );
      return;
    }
    await showSplash('The server did not start in time. Close this window and try again.');
  }

  async function createWindow(): Promise<void> {
    mainWindow = new BrowserWindow({
      width: 1440,
      height: 900,
      // The floor is 1024x768; 640 of height allows for the title bar and the
      // taskbar inside a 768-tall screen.
      minWidth: 1024,
      minHeight: 640,
      backgroundColor: '#111318',
      show: true,
      title: config.productName,
      webPreferences: {
        preload: path.join(here, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        webviewTag: false,
        devTools: !app.isPackaged,
      },
    });

    /*
     * Every guard registers here, before any navigation. `createWindow` used to
     * return early when the server timed out, so exactly the slow or broken
     * start that most needs them left a window with no guards at all and a
     * `mainWindow` that was never nulled.
     */
    const window = mainWindow;

    window.webContents.setWindowOpenHandler(({ url }) => {
      // Anything that is not this panel opens in the real browser, never in
      // here — a window with no address bar is no place to land on an
      // unexpected page.
      if (!sameOrigin(url)) void electronShell.openExternal(url);
      return { action: 'deny' };
    });

    window.webContents.on('will-navigate', (event, url) => {
      if (sameOrigin(url) || url.startsWith('data:text/html')) return;
      event.preventDefault();
      void electronShell.openExternal(url);
    });

    window.webContents.session.setPermissionRequestHandler((_contents, _permission, done) => {
      done(false);
    });

    let rendererReloaded = false;
    window.webContents.on('render-process-gone', (_event, details) => {
      say(`Renderer gone: ${details.reason}`);
      if (rendererReloaded) {
        void showSplash('The window stopped responding. Close it and start OrderBook again.');
        return;
      }
      rendererReloaded = true;
      void showPanel();
    });

    window.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      // -3 is ERR_ABORTED, which a normal in-app navigation produces.
      if (!isMainFrame || code === -3) return;
      say(`Failed to load ${url}: ${description} (${code})`);
    });

    window.on('closed', () => {
      mainWindow = null;
    });

    await showSplash('Starting…');
    await waitForServerThenShow();
  }

  function buildMenu(): void {
    const viewSubmenu: Electron.MenuItemConstructorOptions[] = [
      { role: 'reload', accelerator: 'CmdOrCtrl+R' },
      { role: 'togglefullscreen' },
    ];
    if (!app.isPackaged) viewSubmenu.push({ role: 'toggleDevTools' });

    const isMac = process.platform === 'darwin';

    /*
     * Without this, every text field in the app is missing Copy, Paste, Cut
     * and Select All on macOS specifically. `Cmd+C`/`Cmd+V`/`Cmd+X`/`Cmd+A`
     * are not handled by Chromium's default input behaviour the way they are
     * on Windows — they route through the application menu's `role: 'copy'`
     * etc., which only exist if an Edit menu defines them. An app with no
     * Edit menu is an app where an operator cannot paste a party's GST number
     * into a field on a Mac, and there is no error: the keys just do nothing.
     */
    const editSubmenu: Electron.MenuItemConstructorOptions[] = [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      ...(isMac
        ? ([{ role: 'pasteAndMatchStyle' }, { role: 'delete' }, { role: 'selectAll' }] as const)
        : ([{ role: 'delete' }, { type: 'separator' }, { role: 'selectAll' }] as const)),
    ];

    const template: Electron.MenuItemConstructorOptions[] = [
      // The macOS application menu — named after the app, holds About/Hide/Quit.
      // Its absence is why `Cmd+Q` and `Cmd+H` feel "missing" on a Mac even
      // though the rest of the app works: those live here, not in File.
      ...(isMac ? ([{ role: 'appMenu' as const }] as Electron.MenuItemConstructorOptions[]) : []),
      { label: '&File', submenu: [isMac ? { role: 'close' as const } : { role: 'quit' as const }] },
      { label: '&Edit', submenu: editSubmenu },
      { label: '&View', submenu: viewSubmenu },
      // Standard on every native Mac app: lets `Cmd+M` minimise and groups
      // multiple windows under one menu. Windows/Linux have no equivalent.
      ...(isMac ? ([{ role: 'windowMenu' as const }] as Electron.MenuItemConstructorOptions[]) : []),
      {
        label: '&Help',
        submenu: [
          {
            label: 'Check for updates',
            // Sends a command rather than navigating: the previous version
            // did `loadURL('#/updates')`, and the panel's hash router only
            // recognises `gallery`, so it silently reloaded the dashboard.
            click: () => mainWindow?.webContents.send('orderbook:menuCommand', 'nav.updates'),
          },
          {
            label: 'Keyboard shortcuts',
            accelerator: 'F1',
            click: () => mainWindow?.webContents.send('orderbook:menuCommand', 'help.shortcuts'),
          },
          { type: 'separator' },
          { label: 'Open log folder', click: () => electronShell.showItemInFolder(logPath()) },
          ...(isMac ? [] : [{ label: `Version ${app.getVersion()}`, enabled: false }]),
        ],
      },
    ];

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));

    /*
     * The native About panel (Apple menu → About OrderBook…), rather than the
     * disabled "Version x.y.z" menu item Windows uses. macOS already reserves
     * this slot in the application menu `role: 'appMenu'` builds — leaving it
     * on Electron's default means it shows "Electron" and no version, which is
     * the kind of detail that makes an app feel unfinished on a Mac.
     */
    if (isMac) {
      app.setAboutPanelOptions({
        applicationName: config.productName,
        applicationVersion: app.getVersion(),
        copyright: 'OrderBook',
      });
    }
  }

  /**
   * Launch the setup file **this panel says it prepared**, after hashing it here.
   *
   * The renderer used to pass the path in and this handler checked only that it
   * sat inside `installerDir`. Two things were wrong with that. The folder is
   * on disk and writable by whoever can write it, so "inside the folder" is not
   * a statement about *what* the file is; and the checksum the old comment
   * relied on was taken by a different process, minutes earlier, against bytes
   * that were free to change afterwards.
   *
   * So the renderer no longer says what runs. The shell asks its own server
   * over loopback — the same channel it already learned `installerDir` from,
   * refused to anything off this machine — and then hashes the bytes itself
   * immediately before spawning them. A window that has been taken over can
   * still ask for an update; it cannot choose what gets installed.
   */
  ipcMain.handle('orderbook:applyUpdate', async (): Promise<boolean> => {
    const outcome = await pollHealth();
    if (outcome.kind !== 'ready') {
      say('Refused to update: the panel did not answer its own health check');
      return false;
    }

    const prepared = outcome.health.installer ?? null;
    if (!prepared) {
      say('Refused to update: the panel has no verified installer ready');
      return false;
    }

    // Re-read rather than trusting the value captured at boot: a panel that has
    // relocated its data directory since then reports a different folder.
    installerDir = outcome.health.installerDir ?? installerDir;

    const verdict = await approveInstaller(
      prepared.path,
      prepared.sha256,
      installerDir,
      process.platform,
      // Staged where only this account can write, and hashed there. The
      // releases folder has to stay writable for USB copies and downloads, so
      // it is not somewhere a file can be trusted to sit still.
      path.join(app.getPath('userData'), 'pending-update'),
    );

    if ('refused' in verdict) {
      say(`Refused to run ${prepared.path}: ${verdict.refused}`);
      return false;
    }

    /*
     * Stop the server *before* the installer starts, and wait for it.
     *
     * This used to spawn the installer and then give it "a moment to take
     * hold" — one second — before quitting. That is backwards. The files NSIS
     * is about to replace are the ones the running server has open, and
     * `postgres.exe` under the install directory has its own image locked
     * while the cluster is up. An installer that reaches those files first
     * cannot write them, and the result is a half-applied install on a machine
     * that was told the update was under way.
     *
     * `stopServer` sends the shutdown message and waits for the child to exit,
     * which is what closes the PostgreSQL cluster properly rather than leaving
     * an orphan holding the binary. Only then is there nothing left to lock.
     */
    updatingSince = Date.now();
    say(`Stopping the server before installing ${prepared.version}`);
    await stopServer();

    try {
      if (process.platform === 'darwin') {
        void electronShell.openPath(verdict.path);
      } else {
        spawn(verdict.path, [], { detached: true, stdio: 'ignore' }).unref();
      }

      say(`Installing ${prepared.version} from ${verdict.path}`);
      app.quit();
      return true;
    } catch (error) {
      // The server is already down at this point, so put it back rather than
      // leaving a window attached to nothing because an installer would not
      // start.
      updatingSince = null;
      serverProcess = startServer();
      say(`Could not launch the installer: ${String(error)}`);
      return false;
    }
  });

  ipcMain.handle('orderbook:getDataDir', () => ({
    dataDir: dataDir(),
    isDefault: readDataDirOverride(locationPath()) === null,
  }));

  /*
   * Point this installation at another folder, and restart into it.
   *
   * Offered on the **first-run screen only**, and the renderer is what enforces
   * that. The reason is the Master's: its data directory holds a running
   * PostgreSQL cluster, so moving it is a stop-and-restart rather than a file
   * copy, and its own page is reachable from every machine on the LAN. Before
   * setup there is nothing to protect and nothing to move; afterwards there is
   * both, and the answer is a backup and a restore.
   *
   * The pointer is written first and the server restarted second, so a crash
   * between the two lands on "next launch uses the new folder", which is the
   * outcome the operator asked for.
   */
  ipcMain.handle('orderbook:setDataDir', async (_event, value: unknown) => {
    const target = typeof value === 'string' ? value.trim() : '';
    if (!target) return false;

    writeDataDirOverride(locationPath(), target);
    say(`Data directory set to ${target}; restarting the server`);

    // Held across the stop *and* the start: the supervisor must not read this
    // stop as a crash and race a second server onto the same port, and the
    // window between the two is exactly where it would.
    relocating = true;
    try {
      await stopServer();
      serverProcess = startServer();
    } finally {
      relocating = false;
    }

    await waitForServerThenShow();
    return true;
  });

  ipcMain.handle('orderbook:chooseDirectory', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose where OrderBook keeps its files',
    });

    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle('orderbook:getShellSettings', () => ({
    openAtLogin: app.isPackaged ? app.getLoginItemSettings().openAtLogin : false,
    logFile: logPath(),
  }));

  ipcMain.handle('orderbook:setShellSettings', (_event, value: unknown) => {
    const openAtLogin = (value as { openAtLogin?: unknown } | null)?.openAtLogin === true;
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin });
    return true;
  });

  ipcMain.handle('orderbook:openLogFolder', () => {
    electronShell.showItemInFolder(logPath());
    return true;
  });

  /*
   * Name the application FIRST — before anything asks Electron where its files
   * go, and in particular before the lock below.
   *
   * `requestSingleInstanceLock` is keyed on `userData`, which Electron derives
   * from the application name. Packaged, that name comes from `productName`
   * and the two panels differ; run from source there is none, so both are
   * `Electron`, share one `userData`, and therefore share one lock — whichever
   * panel starts second quits instantly with no window, no dialog and nothing
   * in any log. Reordering these two lines is enough to bring that back.
   *
   * Deliberately NOT `app.setPath('userData', …)`: that relocates the whole
   * Chromium profile, wiping every viewer's stored preferences.
   */
  app.setName(config.productName);

  // One instance only. A second copy would fail to bind the port and leave the
  // operator looking at two windows, one of them permanently on the splash.
  if (!app.requestSingleInstanceLock()) {
    // Say so. A silent exit is indistinguishable from a crash, and this is the
    // single most likely thing to happen to an operator who double-clicks twice.
    dialog.showErrorBox(
      `${config.productName} is already running`,
      'Only one copy can run at a time. Switch to the window that is already open.',
    );
    app.quit();
    return;
  }

  app.on('second-instance', () => {
    if (!mainWindow) {
      void createWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  void app.whenReady().then(async () => {
    log = openLogFile(logPath(), !app.isPackaged);
    say(`${config.productName} ${app.getVersion()} starting`);

    process.on('uncaughtException', (error) => say(`Uncaught exception: ${String(error)}`));
    process.on('unhandledRejection', (reason) => say(`Unhandled rejection: ${String(reason)}`));
    app.on('child-process-gone', (_event, details) =>
      say(`Child process gone: ${details.type} ${details.reason}`),
    );

    if (app.isPackaged && config.autoStartByDefault) {
      // Apply the default once, then never again — this used to run on every
      // launch and silently re-enabled auto-start for anyone who turned it off.
      const settings = readShellSettings(settingsPath());
      if (!settings.autoStartDefaultApplied) {
        app.setLoginItemSettings({ openAtLogin: true });
        writeShellSettings(settingsPath(), { ...settings, autoStartDefaultApplied: true });
      }
    }

    serverProcess = startServer();
    buildMenu();
    await createWindow();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (!mainWindow) void createWindow();
  });

  app.on('before-quit', (event) => {
    if (draining) return;
    draining = true;
    quitting = true;

    // Hold the quit open just long enough for the server to close its sockets
    // and stop its PostgreSQL cluster properly. A half-closed cluster is the
    // one thing here that costs real time to recover from.
    event.preventDefault();

    // Belt and braces: whatever happens in the drain, this process ends.
    setTimeout(() => app.exit(0), STOP_GRACE_MS + 5_000).unref();

    void stopServer().finally(() => {
      log?.close();
      app.quit();
    });
  });
}

export { installerExtension };
