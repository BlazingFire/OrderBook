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
 *  3. **Run a setup file and quit** — or, for the Linux AppImage, replace
 *     the file and start it again. Nothing else can: a web page has no such
 *     power, and the server cannot let an installer replace the files it is
 *     running from mid-request.
 *  4. **Keep the server alive, and say so when it dies.** See `lib/supervisor`.
 *
 * The server runs as a child process, unmodified. Electron ships a Node
 * runtime, so `ELECTRON_RUN_AS_NODE` reuses it rather than bundling a second
 * one — and a crashed server leaves a window that can explain itself, instead
 * of taking the whole application down.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  Notification,
  shell as electronShell,
} from 'electron';

import {
  detectAppImage,
  relaunchArguments,
  relaunchCommand,
  replaceAppImage,
  startDetached,
} from './lib/appimage.js';
import { appMenuTemplate, shellKeyAction } from './lib/app-menu.js';
import { attentionText } from './lib/attention.js';
import { dialogExtensions, dialogTitle } from './lib/dialog-options.js';
import { getJson, interpretHealth, type HealthOutcome } from './lib/health.js';
import { approveInstaller, updateMethod } from './lib/installer.js';
import { isPdfWindowUrl } from './lib/lead-pdf.js';
import { openLogFile, type LogFile } from './lib/log-file.js';
import { rendererHeapFlag, serverHeapMb } from './lib/memory.js';
import { pdfFileName, printOptions } from './lib/print-options.js';
import { backgroundThrottlingFor, parseStationMode } from './lib/station-mode.js';
import {
  readDataDirOverride,
  readShellSettings,
  writeDataDirOverride,
  writeShellSettings,
} from './lib/settings.js';
import { detectStandaloneBuild, loginItemOptions } from './lib/standalone.js';
import { canRestart, isExpectedExit, pruneRestarts, RESTART_LIMIT } from './lib/supervisor.js';
import { uninstallCommand, uninstallScriptsDir } from './lib/uninstall.js';
import {
  decideAfterTaskStart,
  judgeStagedManifest,
  parseUpdatePaths,
  STAGED_MANIFEST,
  TASK_NAME,
  TASK_RESULT,
  UPDATE_PATHS_FILE,
  type ReleaseTrust,
  type UpdatePaths,
} from './lib/staged-update.js';
import { isHighIntegrity, planInstallerLaunch, unattendedInstallDue } from './lib/update-launch.js';

export interface PanelShellConfig {
  readonly panel: 'master' | 'office';
  /** Must match `productName` in the panel's electron-builder.yml. */
  readonly productName: string;
  /**
   * Must match `appId` in the panel's electron-builder.yml. Windows shows a
   * system notification only for an app id its Start-menu shortcut carries.
   */
  readonly appUserModelId: string;
  readonly port: number;
  /** Master builds a PostgreSQL cluster on first run; that is the slow one. */
  readonly readyTimeoutMs: number;
  readonly autoStartByDefault: boolean;
  /**
   * Environment **overrides only** — the shell spreads `process.env`
   * underneath. Returning a bare object here would hand the child no
   * `SystemRoot`, `PATH` or `TEMP`, and `initdb` would not run.
   *
   * `locationFile` is the pointer `dataDir` was just read from, for a server
   * that can move its own folder and has to leave the next start pointing at
   * where it went.
   */
  serverEnv(context: {
    dataDir: string;
    port: number;
    logFile: string;
    locationFile: string;
  }): NodeJS.ProcessEnv;
}

const POLL_INTERVAL_MS = 400;
const STOP_GRACE_MS = 10_000;
/** How long the page has to save its work before an update closes it. */
const FLUSH_TIMEOUT_MS = 8_000;
/** How often the Master's shell asks its server whether the nightly update is due. */
const AUTO_UPDATE_POLL_MS = 30_000;
const RENDERER_RELOAD_WINDOW_MS = 5 * 60_000;

export function runPanelShell(config: PanelShellConfig): void {
  const ORIGIN = `http://localhost:${config.port}`;
  /*
   * The folder this compiled shell sits in, `<panel>/electron/dist`. It comes
   * from `app.getAppPath()` rather than `import.meta.url`, because the Windows 7
   * build compiles this same file to CommonJS, where `import.meta` does not
   * exist. The app path is the panel folder (or its `app.asar`) when the panel
   * is launched as an app, and the `dist` folder itself when a developer
   * launches `electron <panel>/electron/dist/<panel>.main.js` directly
   * (Electron's default app then uses the script's own folder). Getting this
   * wrong loses the preload script, and without it the window has no
   * `orderbook` bridge, which the page reads as "not the desktop app".
   */
  const appPath = app.getAppPath();
  const here = existsSync(path.join(appPath, 'electron', 'dist'))
    ? path.join(appPath, 'electron', 'dist')
    : appPath;

  /**
   * The standalone `.exe`, or `null` for an installed build. Decided once:
   * the launcher's variables do not change while the process lives, and three
   * handlers below turn on the answer (see `lib/standalone.ts`).
   */
  const standalone = detectStandaloneBuild(process.env, app.isPackaged);

  /**
   * The AppImage this copy was launched from, or `null` for anything else, and
   * with it how this copy takes an update — decided once for the same reason
   * as `standalone` (see `updateMethod` in `lib/installer.ts`).
   */
  const appImage = detectAppImage(process.platform, process.env, process.execPath, app.isPackaged);
  const updateBy = updateMethod(process.platform, { standalone: standalone !== null, appImage });

  let serverProcess: ChildProcess | null = null;
  let mainWindow: BrowserWindow | null = null;
  let log: LogFile | null = null;
  let quitting = false;
  /** Set while `orderbook:setDataDir` stops the server on purpose. */
  let relocating = false;
  let draining = false;
  let updatingSince: number | null = null;
  /** One update at a time, and the version the nightly watcher has already started. */
  let applyingUpdate = false;
  let autoStartedVersion: string | null = null;
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
  /** Where a log opened *now* would go — which is only asked once, at launch. */
  const logPath = (): string => path.join(dataDir(), 'logs', `${config.panel}.log`);
  /**
   * The log this process is writing, for everything that tells somebody where
   * to look. Not `logPath()`: the log is opened once, and a storage move
   * rewrites the pointer underneath a running shell — an Office Panel's, from
   * the Master or its storage card, or `orderbook:setDataDir` here. Asked
   * afresh after one, the answer is a file in the new folder that nothing
   * writes to (a stale copy, after an Office move), while every line since
   * the move still goes to this one until the next launch opens the new one.
   */
  const openLogPath = (): string => log?.path ?? logPath();
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
    // The floors and ceilings, and why, are in `lib/memory.ts`.
    const maxOldSpaceMb = serverHeapMb(totalRamMb, config.panel, process.arch);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // Reuse Electron's own Node rather than shipping a second runtime.
      ELECTRON_RUN_AS_NODE: '1',
      NODE_OPTIONS: `--max-old-space-size=${maxOldSpaceMb}`,
      ORDERBOOK_PANEL: config.panel,
      ORDERBOOK_RAM_CAP_MB: String(ramCapMb),
      ...config.serverEnv({
        dataDir: dataDir(),
        port: config.port,
        logFile: openLogPath(),
        locationFile: locationPath(),
      }),
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
      detail: `It has stopped ${RESTART_LIMIT} times in a few minutes, so it has not been restarted again.\n\nThe log is at ${openLogPath()}.`,
    });

    if (choice.response === 0) {
      restarts = [];
      serverProcess = startServer();
      await showSplash('Restarting…');
      void waitForServerThenShow();
      return;
    }
    if (choice.response === 1) electronShell.showItemInFolder(openLogPath());
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
    // node:http rather than fetch: Electron 22 (the Windows 7 build) runs the
    // main process on Node 16, where fetch is not there without a flag.
    const body = await getJson(`${ORIGIN}/api/health`, POLL_INTERVAL_MS * 2);
    return body === null ? { kind: 'not-listening' } : interpretHealth(body, config.panel);
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
        height:100vh;background:#f2f4f5;color:#10161a;
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

  /** A lead's or a report's PDF on this panel — the only URLs it may open a window of its own for. */
  const isLeadPdf = (url: string): boolean => isPdfWindowUrl(ORIGIN, url);

  /**
   * Preview PDF (owner, 2026-10-13: the in-app viewer window showed blank on
   * both panels). The shell fetches the PDF with the panel's own sign-in, saves
   * it to the temp folder and hands it to Windows' PDF app. Only on a PC with no
   * PDF app (Windows 7) does it fall back to a window with Chromium's viewer —
   * no preload and no Node, opening nothing and going nowhere.
   */
  async function openPdf(url: string): Promise<void> {
    try {
      const response = await new Promise<{ status: number; type: string; name: string; bytes: Buffer }>(
        (resolve, reject) => {
          const request = net.request({ url, useSessionCookies: true });
          request.on('response', (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            res.on('end', () => {
              const header = (name: string): string => {
                const value = res.headers[name];
                return (Array.isArray(value) ? value[0] : value) ?? '';
              };
              resolve({
                status: res.statusCode,
                type: header('content-type'),
                name: /filename="([^"]+)"/.exec(header('content-disposition'))?.[1] ?? '',
                bytes: Buffer.concat(chunks),
              });
            });
            res.on('error', reject);
          });
          request.on('error', reject);
          request.end();
        },
      );
      if (response.status !== 200 || !response.type.startsWith('application/pdf')) {
        say(`Preview PDF: ${url} answered ${response.status} ${response.type}`);
        await dialog.showMessageBox({
          type: 'error',
          title: config.productName,
          message: 'The PDF could not be made. Check that the Master Panel is reachable and try again.',
        });
        return;
      }
      const dir = path.join(app.getPath('temp'), 'OrderBook PDF');
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, pdfFileName(response.name || 'preview'));
      await writeFile(file, response.bytes);
      const failed = await electronShell.openPath(file);
      if (!failed) return;
      say(`Preview PDF: no PDF app (${failed}); opening the built-in viewer`);
    } catch (error) {
      say(`Preview PDF failed: ${String(error)}`);
    }
    const child = new BrowserWindow({
      width: 960,
      height: 900,
      autoHideMenuBar: true,
      backgroundColor: '#FFFFFF',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        plugins: true,
        spellcheck: false,
        webviewTag: false,
        devTools: !app.isPackaged,
      },
    });
    child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    child.webContents.on('will-navigate', (event) => event.preventDefault());
    void child.loadURL(url);
  }

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
      // The light theme's page colour, which both panels now open in, so the
      // window does not flash dark before the first paint.
      backgroundColor: '#f2f4f5',
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

    // No menu bar (1.4 R2). `setApplicationMenu(null)` already removes it; this
    // keeps Alt from summoning one on a platform that would.
    window.setMenuBarVisibility(false);

    // F11 (full screen) and, in a dev build, Ctrl+Shift+I: the two accelerators
    // the removed View menu owned that no renderer command replaced.
    window.webContents.on('before-input-event', (event, input) => {
      const action = shellKeyAction(input, app.isPackaged);
      if (action === 'toggleFullScreen') {
        event.preventDefault();
        window.setFullScreen(!window.isFullScreen());
      } else if (action === 'toggleDevTools') {
        event.preventDefault();
        window.webContents.toggleDevTools();
      }
    });

    window.webContents.setWindowOpenHandler(({ url }) => {
      // A lead's or report's Preview PDF opens beside the panel, never over it
      // (that would leave the panel with no way back): see `openPdf`.
      if (isLeadPdf(url)) {
        void openPdf(url);
        return { action: 'deny' };
      }
      // Anything else that is not this panel opens in the real browser, never
      // in here — a window with no address bar is no place to land on an
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

    // One reload per five minutes. A single crash in a long day is reloaded
    // past; a window that crashes again straight after is shown the splash
    // rather than reloaded in a loop.
    let lastRendererReload = 0;
    window.webContents.on('render-process-gone', (_event, details) => {
      say(`Renderer gone: ${details.reason}`);
      if (Date.now() - lastRendererReload < RENDERER_RELOAD_WINDOW_MS) {
        void showSplash('The window stopped responding. Close it and start OrderBook again.');
        return;
      }
      lastRendererReload = Date.now();
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

  /**
   * No menu bar on Windows and Linux (1.4 R2); on macOS only the minimal menu
   * its Copy and Paste keys need. See `lib/app-menu.ts` for what became of each
   * old item.
   */
  function buildMenu(): void {
    const template = appMenuTemplate(process.platform);
    Menu.setApplicationMenu(
      template ? Menu.buildFromTemplate(template as Electron.MenuItemConstructorOptions[]) : null,
    );

    /*
     * The native About panel (Apple menu -> About OrderBook...). macOS reserves
     * the slot in the application menu's `appMenu` role; left on Electron's
     * default it shows "Electron" and no version.
     */
    if (process.platform === 'darwin') {
      app.setAboutPanelOptions({
        applicationName: config.productName,
        applicationVersion: app.getVersion(),
        copyright: 'OrderBook',
      });
    }
  }

  /**
   * The folders the update task works in, from the file the installer wrote into
   * the (administrator-only) program folder. Never from the environment, which
   * this account's other programs can change.
   */
  async function readUpdatePaths(): Promise<UpdatePaths | null> {
    try {
      return parseUpdatePaths(
        await readFile(path.join(process.resourcesPath, 'apply-update', UPDATE_PATHS_FILE), 'utf8'),
      );
    } catch {
      return null;
    }
  }

  /** The installer's update task is registered, and the folders it works in exist. */
  async function updateTaskIsReady(): Promise<boolean> {
    const paths = await readUpdatePaths();
    if (!paths || !existsSync(paths.stage) || !existsSync(paths.work)) return false;
    return new Promise((resolve) => {
      execFile('schtasks.exe', ['/Query', '/TN', TASK_NAME], { windowsHide: true, timeout: 10_000 }, (error) =>
        resolve(!error),
      );
    });
  }

  /** The release keys and signed-payload rules of the installed program, the ones the task will use. */
  async function loadReleaseTrust(): Promise<ReleaseTrust | null> {
    try {
      const shared = path.join(process.resourcesPath, 'panel', 'node_modules', '@orderbook', 'shared', 'dist', 'index.js');
      return (await import(pathToFileURL(shared).href)) as ReleaseTrust;
    } catch {
      return null;
    }
  }

  /**
   * Put the verified setup file and its signed manifest where the update task
   * reads them, after making the decision the task will make. Resolves to the
   * reason when it must not go ahead, or `null` when it may.
   */
  async function stageForUpdateTask(
    setupPath: string,
    prepared: { sha256: string; version: string },
  ): Promise<string | null> {
    if (!installerDir) return 'the releases folder is not known';
    let manifestText: string | null = null;
    for (const name of ['latest-win32.json', 'latest.json']) {
      try {
        const text = await readFile(path.join(installerDir, name), 'utf8');
        const parsed = JSON.parse(text) as { sha256?: string; version?: string };
        if (parsed.sha256?.toLowerCase() === prepared.sha256.toLowerCase() && parsed.version === prepared.version) {
          manifestText = text;
          break;
        }
      } catch {
        // Not there, or not this build's: the next name gets a turn.
      }
    }
    if (manifestText === null) return 'the signed manifest for this build is not in the releases folder';

    const trust = await loadReleaseTrust();
    if (!trust) return 'the installed release keys could not be loaded';
    const verdict = judgeStagedManifest(JSON.parse(manifestText), app.getVersion(), trust);
    if (!verdict.ok) return verdict.reason;
    if (verdict.manifest.file !== path.basename(setupPath)) return 'the manifest names another file';

    const paths = await readUpdatePaths();
    if (!paths) return 'the installer did not record where the update folders are';
    const { stage } = paths;
    try {
      await mkdir(stage, { recursive: true });
      for (const entry of await readdir(stage)) await rm(path.join(stage, entry), { force: true, recursive: true });
      await copyFile(setupPath, path.join(stage, verdict.manifest.file));
      await writeFile(path.join(stage, STAGED_MANIFEST), manifestText);
    } catch (error) {
      return `the files could not be staged (${String(error)})`;
    }
    return null;
  }

  /**
   * After asking Windows to run the update task, wait for what it says (the task
   * writes `result.json` into its own folder, which this account may read). The
   * server is stopped by now, so a task that refuses, or never starts (its account
   * is not logged on, it crashed), must bring it back: `recover` says so. Only
   * `installing` lets this app quit.
   */
  async function waitForUpdateTask(startedAt: number): Promise<'quit' | 'recover'> {
    const paths = await readUpdatePaths();
    const resultFile = paths ? path.join(paths.work, TASK_RESULT) : null;
    for (;;) {
      let status: unknown;
      if (resultFile) {
        try {
          // Only an answer written after this run was asked for: an old one is not about this run.
          if ((await stat(resultFile)).mtimeMs >= startedAt - 1_000) {
            status = (JSON.parse(await readFile(resultFile, 'utf8')) as { status?: unknown }).status;
          }
        } catch {
          // Not written yet, or half-written: the next look decides.
        }
      }
      const next = decideAfterTaskStart(status, Date.now() - startedAt);
      if (next !== 'wait') return next;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  /** Whether this process holds an elevated token. Windows only; anything else is "no". */
  function isElevated(): Promise<boolean> {
    return new Promise((resolve) => {
      execFile('whoami', ['/groups'], { windowsHide: true, timeout: 10_000 }, (error, stdout) => {
        resolve(!error && isHighIntegrity(stdout));
      });
    });
  }

  /**
   * Ask the page to save everything it can before it is closed, and wait for it
   * (1.4 R7b). The page answers `orderbook:beforeUpdateDone` when its draft
   * stores have been written, and a page that does not answer (an older web
   * bundle, a hung renderer) is not waited on for longer than `FLUSH_TIMEOUT_MS`.
   */
  async function flushRenderer(): Promise<void> {
    const window = mainWindow;
    if (!window || window.isDestroyed()) return;
    await new Promise<void>((resolve) => {
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        ipcMain.removeListener('orderbook:beforeUpdateDone', onDone);
        resolve();
      };
      const onDone = (event: Electron.IpcMainEvent): void => {
        if (event.sender === window.webContents) finish();
      };
      const timer = setTimeout(finish, FLUSH_TIMEOUT_MS);
      ipcMain.on('orderbook:beforeUpdateDone', onDone);
      window.webContents.send('orderbook:beforeUpdate');
    });
  }

  /**
   * The Master's nightly update (1.4 R8): its server says, on the loopback
   * health route, that an unattended install is due, and this carries it out
   * through the same checks and the same launch as the Install button. Only the
   * Master has one; an Office Panel is updated by hand or by its own button.
   */
  function startAutoUpdateWatcher(): void {
    if (config.panel !== 'master') return;
    const timer = setInterval(() => {
      void (async () => {
        if (applyingUpdate || quitting) return;
        const outcome = await pollHealth();
        if (outcome.kind !== 'ready') return;
        const version = unattendedInstallDue(outcome.health, autoStartedVersion);
        if (!version) return;
        autoStartedVersion = version;
        say(`The nightly update is due: installing ${version} with nobody signed in`);
        await applyPreparedUpdate(true);
      })().catch((error: unknown) => say(`Nightly update check failed: ${String(error)}`));
    }, AUTO_UPDATE_POLL_MS);
    timer.unref();
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
  async function applyPreparedUpdate(unattended: boolean): Promise<boolean> {
    if (applyingUpdate) return false;
    applyingUpdate = true;
    try {
      return await applyPreparedUpdateOnce(unattended);
    } finally {
      applyingUpdate = false;
    }
  }

  async function applyPreparedUpdateOnce(unattended: boolean): Promise<boolean> {
    /*
     * The standalone build has no installer to hand the setup file to. Running
     * it would install a second, per-machine copy beside this one and leave
     * the person with two panels sharing one data directory. The Updates
     * screen already knows (`getShellSettings().standalone`) and does not offer
     * the button; this is the guard for a page that asks anyway.
     */
    if (standalone) {
      say('Refused to update: this is the standalone build, which is replaced by hand');
      return false;
    }

    /*
     * Linux, but not started from an AppImage — in a shipped build, the `.deb`.
     * That belongs to dpkg: its files sit in a folder only root can write, and
     * the file the panel downloads is the AppImage in any case. The Updates
     * screen already knows (`getShellSettings().systemPackage`) and says to
     * install the new package instead; this is the guard for a page that asks
     * anyway.
     */
    if (updateBy === 'system-package') {
      say(
        'Refused to update: this copy was not started from an AppImage, and a .deb install is replaced by the package manager',
      );
      return false;
    }

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

    if (updateBy === 'appimage' && appImage) {
      await flushRenderer();
      return updateAppImage(verdict.path, appImage, prepared.version);
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
    /*
     * Work out how the setup will be started *before* anything is stopped. A
     * nightly update with nobody to approve a UAC prompt declines here, with
     * the server still running, rather than after it has been shut down.
     */
    const elevated = process.platform === 'win32' ? await isElevated() : false;
    const plan = planInstallerLaunch({
      platform: process.platform,
      file: verdict.path,
      unattended,
      elevated,
      taskReady:
        process.platform === 'win32' && unattended && !elevated ? await updateTaskIsReady() : false,
    });
    if (plan.how === 'needs-approval') {
      say(
        `Did not install ${prepared.version} unattended: it needs administrator approval and nobody is here to give it. The server is still running.`,
      );
      return false;
    }
    if (plan.how === 'task') {
      // The task checks everything again, in its own elevated process. Checking
      // the same things here first is what makes a refusal happen with the
      // server still running, not after it has been stopped.
      const refusal = await stageForUpdateTask(verdict.path, prepared);
      if (refusal) {
        say(`Did not install ${prepared.version} through the update task: ${refusal}. The server is still running.`);
        return false;
      }
    }

    // Everything the page holds that can still be saved, before the window goes.
    await flushRenderer();

    updatingSince = Date.now();
    say(`Stopping the server before installing ${prepared.version}`);
    await stopServer();

    try {
      /*
       * `open` is the macOS `.dmg`, through the OS shell as ever. On Windows
       * the setup is started silent with `--force-run`, so the new version
       * opens by itself when the install ends (`lib/update-launch.ts` says why
       * each way of starting it is used). A declined UAC prompt makes
       * PowerShell exit non-zero, which lands in the catch below and puts the
       * server back.
       */
      if (plan.how === 'open') {
        const failure = await electronShell.openPath(verdict.path);
        if (failure) throw new Error(failure);
      } else if (plan.how === 'task') {
        const startedAt = Date.now();
        const child = spawn(plan.command, plan.args, { stdio: 'ignore', windowsHide: true });
        const [code] = (await once(child, 'exit')) as [number | null];
        if (code !== 0) throw new Error(`Windows did not start the update task (exit ${String(code)})`);
        // The task may still refuse after Windows started it: wait for it to say so.
        if ((await waitForUpdateTask(startedAt)) === 'recover') {
          throw new Error('the update task did not go on to install; bringing the server back');
        }
      } else {
        const child = spawn(plan.command, plan.args, {
          detached: plan.how === 'spawn',
          stdio: 'ignore',
          windowsHide: true,
        });
        if (plan.how === 'spawn') {
          // The installer outlives this process; it only has to have started.
          await new Promise<void>((resolve, reject) => {
            child.once('error', reject);
            child.once('spawn', () => resolve());
          });
          child.unref();
        } else {
          const [code] = (await once(child, 'exit')) as [number | null];
          if (code !== 0) throw new Error(`Windows did not start the installer (exit ${String(code)})`);
        }
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
  }

  ipcMain.handle('orderbook:applyUpdate', (event): Promise<boolean> | boolean => {
    // Only the panel's own window may ask (the PDF window has no preload, but
    // this is the shell's most dangerous call, so the sender is checked anyway).
    if (!mainWindow || event.sender !== mainWindow.webContents) return false;
    return applyPreparedUpdate(false);
  });

  /**
   * The AppImage's half of `orderbook:applyUpdate`: replace the file this copy
   * was launched from with the verified one, and start it once this process
   * has gone (`lib/appimage.ts`).
   *
   * The order is the reverse of the installer's, on purpose. An installer has
   * to find the server stopped, because it overwrites files the server has
   * open; replacing an AppImage touches nothing the running copy uses, since
   * the old file stays readable to what already has it open. So the file is
   * replaced *first*, while everything is still running: a folder this account
   * cannot write, or a full disk, refuses the update with nothing stopped and
   * nothing to put back.
   */
  async function updateAppImage(
    verified: string,
    target: string,
    version: string,
  ): Promise<boolean> {
    try {
      await replaceAppImage(verified, target);
    } catch (error) {
      say(`Refused to update: could not replace ${target}: ${String(error)}`);
      return false;
    }

    updatingSince = Date.now();
    say(`Replaced ${target} with ${version}; stopping the server and starting the new version`);
    await stopServer();

    try {
      // Awaited until the relaunch is running, because `spawn` reports one it
      // cannot start asynchronously (`startDetached`); otherwise a failure
      // would never reach the catch below, and this copy would quit anyway.
      await startDetached(
        relaunchCommand(target, process.pid, relaunchArguments(process.env, process.argv.slice(1))),
      );
    } catch (error) {
      // The new file is already in place, so the next start runs it. Until
      // then, put the server back rather than leave a window attached to
      // nothing.
      updatingSince = null;
      serverProcess = startServer();
      say(`Could not start ${version}: ${String(error)}. It runs the next time OrderBook starts.`);
      return false;
    }

    app.quit();
    return true;
  }

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

  /*
   * Native choosers: a folder (the data folder at first run, a backup drive)
   * and a file (a backup archive for Magic restore). Only the panel's own
   * window may ask, and the title and extensions it sends are checked
   * (`lib/dialog-options.ts`). The path that comes back is what the person
   * picked; the server still checks it before using it.
   */
  ipcMain.handle('orderbook:chooseDirectory', async (event, value: unknown) => {
    const window = mainWindow;
    if (!window || event.sender !== window.webContents) return null;
    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory', 'createDirectory'],
      title: dialogTitle(value, 'Choose where OrderBook keeps its files'),
    });

    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle('orderbook:chooseFile', async (event, value: unknown) => {
    const window = mainWindow;
    if (!window || event.sender !== window.webContents) return null;
    const extensions = dialogExtensions(value);
    const result = await dialog.showOpenDialog(window, {
      properties: ['openFile'],
      title: dialogTitle(value, 'Choose a file'),
      filters: [{ name: extensions.map((extension) => `.${extension}`).join(', '), extensions }],
    });

    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  /*
   * `loginItemOptions` on every login-item call, read and write alike: a
   * standalone build must register the `.exe` the person keeps, not the copy
   * under %TEMP% it is running from, which is gone by the next morning.
   */
  ipcMain.handle('orderbook:getShellSettings', () => ({
    openAtLogin: app.isPackaged
      ? app.getLoginItemSettings(loginItemOptions(standalone)).openAtLogin
      : false,
    logFile: openLogPath(),
    standalone: standalone !== null,
    systemPackage: updateBy === 'system-package',
  }));

  ipcMain.handle('orderbook:setShellSettings', (_event, value: unknown) => {
    const openAtLogin = (value as { openAtLogin?: unknown } | null)?.openAtLogin === true;
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin, ...loginItemOptions(standalone) });
    return true;
  });

  /*
   * Printing for the order notes. Only the panel's own window may ask — the
   * frame check is `mainWindow`, not a sender's claim — and the printer name it
   * sends is checked against what Windows lists (`lib/print-options.ts`).
   */
  ipcMain.handle('orderbook:listPrinters', async (event) => {
    if (event.sender !== mainWindow?.webContents) return [];
    const printers = await event.sender.getPrintersAsync();
    return printers.map((printer) => ({
      name: printer.name,
      displayName: printer.displayName || printer.name,
      isDefault: printer.isDefault,
    }));
  });

  ipcMain.handle('orderbook:printPage', async (event, value: unknown) => {
    if (event.sender !== mainWindow?.webContents) return { ok: false, error: 'Not allowed' };
    const installed = (await event.sender.getPrintersAsync()).map((printer) => printer.name);
    const options = printOptions(value, installed);
    return new Promise<{ ok: boolean; error?: string }>((resolve) => {
      event.sender.print(options, (success, reason) => {
        // Closing the system dialog is a cancel, not a failure worth a toast.
        resolve(success || reason === 'cancelled' ? { ok: true } : { ok: false, error: reason });
      });
    });
  });

  /*
   * Save PDF for the order notes: the page as printed (A4, its print
   * stylesheet), written where the person chooses. The path comes from the
   * dialog in this process, never from the page; the page offers only a name,
   * cleaned by `pdfFileName`. `printToPDF` takes an options object from
   * Electron 21, so this is the same call on 22 (the Windows 7 build) and 33.
   */
  ipcMain.handle('orderbook:savePdf', async (event, value: unknown) => {
    if (event.sender !== mainWindow?.webContents || !mainWindow) {
      return { ok: false, error: 'Not allowed' };
    }
    try {
      const bytes = await event.sender.printToPDF({
        printBackground: true,
        preferCSSPageSize: true,
        // Explicit, to match the print: A4 and no margin of Chromium's own.
        pageSize: 'A4',
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
      });
      const chosen = await dialog.showSaveDialog(mainWindow, {
        defaultPath: path.join(
          app.getPath('documents'),
          pdfFileName((value as { fileName?: unknown } | null)?.fileName),
        ),
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });
      if (chosen.canceled || !chosen.filePath) return { ok: false, cancelled: true };
      await writeFile(chosen.filePath, bytes);
      return { ok: true, path: chosen.filePath };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  /*
   * Auto-print station mode (the Printroom). While it is on, the panel's window
   * keeps rendering and running timers when it is minimised or hidden, so a
   * printer PC left minimised keeps printing. Only the panel's own window may
   * ask, only the literal `true` turns it on (`lib/station-mode.ts`), and it
   * changes nothing about what may be printed silently: that stays the printers
   * Windows lists (`orderbook:printPage`).
   */
  ipcMain.handle('orderbook:setStationMode', (event, value: unknown): boolean => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return false;
    mainWindow.webContents.setBackgroundThrottling(backgroundThrottlingFor(parseStationMode(value)));
    return true;
  });

  /*
   * A notice the operator should see with the window behind another one: the
   * Office's link offline for an hour, say. Only the panel's own window may
   * ask, and the text is clamped (`lib/attention.ts`). The taskbar button
   * flashes until the window is focused. The system notification appears only
   * where the OS supports one, which the Windows 7 build may not; the in-app
   * bell carries the notice either way.
   */
  // Windows already flashing, so a burst of notices adds one focus listener, not one each.
  const flashing = new WeakSet<BrowserWindow>();
  ipcMain.handle('orderbook:notify', (event, value: unknown): boolean => {
    const window = mainWindow;
    if (!window || event.sender !== window.webContents) return false;
    const notice = attentionText(value);
    if (!notice) return false;
    if (!window.isFocused() && !flashing.has(window)) {
      flashing.add(window);
      window.flashFrame(true);
      window.once('focus', () => {
        flashing.delete(window);
        window.flashFrame(false);
      });
    }
    if (Notification.isSupported()) {
      const toast = new Notification({ title: notice.title, body: notice.body });
      toast.on('click', () => {
        if (window.isDestroyed()) return;
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
      });
      toast.show();
    }
    return true;
  });

  ipcMain.handle('orderbook:openLogFolder', () => {
    electronShell.showItemInFolder(openLogPath());
    return true;
  });

  /*
   * Remove this panel from the machine.
   *
   * The page decides only one thing — whether the data survives — and it is
   * not trusted to have asked: the confirmation below is native, so a window
   * that has been taken over still cannot delete a company's records without
   * somebody reading a dialog and clicking Uninstall. Everything else about
   * the removal is the script's, in `tools/uninstall/`.
   */
  ipcMain.handle('orderbook:uninstall', async (_event, value: unknown): Promise<boolean> => {
    const keepData = (value as { keepData?: unknown } | null)?.keepData;
    // Not `!== true`: a missing or mistyped field must not quietly mean "and
    // delete the database", which is what the falsy reading of it would be.
    if (typeof keepData !== 'boolean') {
      say('Refused to uninstall: the request did not say whether to keep the data');
      return false;
    }

    const scriptsDir = uninstallScriptsDir(app.isPackaged, process.resourcesPath, here);
    const command = uninstallCommand({
      platform: process.platform,
      panel: config.panel,
      keepData,
      scriptsDir,
    });

    if (!command) {
      say(`Refused to uninstall: no uninstaller ships for ${process.platform}`);
      return false;
    }

    const choice = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Uninstall', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: `Uninstall ${config.productName}?`,
      message: `${config.productName} will be removed from this computer.`,
      detail:
        (keepData
          ? 'The database, the uploaded photos and the settings stay on this computer, so installing the panel again picks them up where they were.'
          : 'The database, the uploaded photos and the settings will be deleted as well. Every party, lead and order kept on this computer goes with them. This cannot be undone.') +
        (standalone
          ? `\n\nThis is the standalone build, so there is no program folder to remove. Delete the file yourself afterwards: ${standalone.executable}`
          : ''),
    });

    if (choice.response !== 0) return false;

    /*
     * The script's own name, repeated here rather than exported, because this
     * is the only place that needs to know a file is there *before* the point
     * of no return. `uninstallCommand` builds a command line; asking it what
     * file that line names would mean parsing the AppleScript back out.
     */
    const script = path.join(
      scriptsDir,
      process.platform === 'win32' ? 'uninstall-orderbook.ps1' : 'uninstall-orderbook.sh',
    );
    if (!existsSync(script)) {
      say(`Refused to uninstall: ${script} is not in this build`);
      return false;
    }

    /*
     * Stop the server first, for the reason `orderbook:applyUpdate` gives: the
     * files about to be deleted are the ones the running server has open, and
     * `postgres.exe` under the install directory holds its own image locked
     * while the cluster is up. A removal that trips over that leaves half a
     * program folder behind on a machine that was told it was gone.
     *
     * `quitting` is set across the stop so the supervisor does not read it as a
     * crash and start a second server into a folder being deleted.
     */
    quitting = true;
    say(`Uninstalling; stopping the server first (data will be ${keepData ? 'kept' : 'deleted'})`);
    await stopServer();

    try {
      spawn(command.file, command.args, { detached: true, stdio: 'ignore' }).unref();
      say('Uninstaller started');
      app.quit();
      return true;
    } catch (error) {
      // Nothing has been deleted yet — the script is what deletes — so put the
      // server back rather than leaving a window over a dead backend because a
      // command would not start.
      quitting = false;
      serverProcess = startServer();
      say(`Could not start the uninstaller: ${String(error)}`);
      return false;
    }
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
  // Windows ties a system notification to this id; it must match the installer's.
  if (process.platform === 'win32') app.setAppUserModelId(config.appUserModelId);

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

  // The window's heap cap on a small PC (`lib/memory.ts`). Chromium reads
  // switches only before the app is ready.
  const rendererFlag = rendererHeapFlag(Math.round(os.totalmem() / (1024 * 1024)));
  if (rendererFlag) app.commandLine.appendSwitch('js-flags', rendererFlag);

  void app.whenReady().then(async () => {
    log = openLogFile(logPath(), !app.isPackaged);
    say(`${config.productName} ${app.getVersion()} starting`);
    if (standalone) say(`Standalone build, launched from ${standalone.executable}`);

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
        app.setLoginItemSettings({ openAtLogin: true, ...loginItemOptions(standalone) });
        writeShellSettings(settingsPath(), { ...settings, autoStartDefaultApplied: true });
      }
    }

    serverProcess = startServer();
    buildMenu();
    startAutoUpdateWatcher();
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
