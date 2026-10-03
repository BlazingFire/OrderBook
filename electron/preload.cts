/**
 * The whole bridge between a panel's web UI and its desktop shell.
 *
 * `contextIsolation` is on, `nodeIntegration` off and `sandbox` on, so this is
 * the only surface the page ever sees — it gets a function that asks for the
 * prepared update, not a `spawn`. A page that could ask for anything to be run
 * would make the shell strictly more dangerous than the browser tab it
 * replaces, so it does not even name the file: the shell asks its own panel
 * which one, refuses anything outside that panel's updates folder, and hashes
 * the bytes itself.
 *
 * Panel-agnostic: both panels load this same file. It used to carry a `panel`
 * field naming which one, which nothing ever read.
 *
 * CommonJS (`.cts`) deliberately: Electron preload scripts are not ESM.
 */

import { contextBridge, ipcRenderer } from 'electron';

/**
 * What the page does when an update is about to close it (1.4 R7b): save every
 * draft it can. The shell sends `orderbook:beforeUpdate` and waits for the
 * answer, so this always answers, even when the page registered nothing.
 */
let beforeUpdate: (() => Promise<void> | void) | null = null;
ipcRenderer.on('orderbook:beforeUpdate', () => {
  void Promise.resolve()
    .then(() => beforeUpdate?.())
    .catch(() => undefined)
    .finally(() => ipcRenderer.send('orderbook:beforeUpdateDone'));
});

contextBridge.exposeInMainWorld('orderbook', {
  shellVersion: process.versions.electron,

  /**
   * Ask the shell to install the update the panel has already prepared.
   *
   * Takes no path on purpose. The window does not get to say what runs — the
   * shell asks the panel over loopback and hashes the bytes itself.
   */
  applyUpdate: (): Promise<boolean> =>
    ipcRenderer.invoke('orderbook:applyUpdate') as Promise<boolean>,

  /** Where this installation keeps its data, and whether that is the default. */
  getDataDir: (): Promise<{ dataDir: string; isDefault: boolean }> =>
    ipcRenderer.invoke('orderbook:getDataDir') as Promise<{ dataDir: string; isDefault: boolean }>,

  /** Point this installation at another folder and restart the server into it. */
  setDataDir: (dataDir: string): Promise<boolean> =>
    ipcRenderer.invoke('orderbook:setDataDir', dataDir) as Promise<boolean>,

  /** A native folder chooser: where the panel's data lives, or a backup drive. */
  chooseDirectory: (options?: { title?: string }): Promise<string | null> =>
    ipcRenderer.invoke('orderbook:chooseDirectory', options) as Promise<string | null>,

  /** A native file chooser, for a backup archive to restore. */
  chooseFile: (options?: { title?: string; extensions?: string[] }): Promise<string | null> =>
    ipcRenderer.invoke('orderbook:chooseFile', options) as Promise<string | null>,

  getShellSettings: (): Promise<{
    openAtLogin: boolean;
    logFile: string;
    standalone: boolean;
    systemPackage: boolean;
  }> =>
    ipcRenderer.invoke('orderbook:getShellSettings') as Promise<{
      openAtLogin: boolean;
      logFile: string;
      standalone: boolean;
      systemPackage: boolean;
    }>,

  setShellSettings: (value: { openAtLogin: boolean }): Promise<boolean> =>
    ipcRenderer.invoke('orderbook:setShellSettings', value) as Promise<boolean>,

  openLogFolder: (): Promise<boolean> =>
    ipcRenderer.invoke('orderbook:openLogFolder') as Promise<boolean>,

  /**
   * Uninstall this panel. The page chooses only whether the data survives —
   * the shell owns the confirmation, the script and the quit.
   */
  uninstall: (options: { keepData: boolean }): Promise<boolean> =>
    ipcRenderer.invoke('orderbook:uninstall', options) as Promise<boolean>,

  /** The printers Windows lists on this PC — the order-note preview's picker. */
  listPrinters: (): Promise<{ name: string; displayName: string; isDefault: boolean }[]> =>
    ipcRenderer.invoke('orderbook:listPrinters') as Promise<
      { name: string; displayName: string; isDefault: boolean }[]
    >,

  /** Print the page (A4, its print stylesheet) — to a named printer, or via the system dialog. */
  printPage: (options: { deviceName?: string; copies?: number }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('orderbook:printPage', options) as Promise<{ ok: boolean; error?: string }>,

  /** Save the page as a PDF. The shell asks where; the page offers only a file name. */
  savePdf: (options: {
    fileName: string;
  }): Promise<{ ok: boolean; path?: string; cancelled?: boolean; error?: string }> =>
    ipcRenderer.invoke('orderbook:savePdf', options) as Promise<{
      ok: boolean;
      path?: string;
      cancelled?: boolean;
      error?: string;
    }>,
  /** Keep the window rendering while minimised, for an auto-print station. */
  setStationMode: (on: boolean): Promise<boolean> =>
    ipcRenderer.invoke('orderbook:setStationMode', on) as Promise<boolean>,

  /** A system notification plus a taskbar flash, for a notice the operator should not miss. */
  notify: (notice: { title: string; body: string }): Promise<boolean> =>
    ipcRenderer.invoke('orderbook:notify', notice) as Promise<boolean>,

  /** Register what the page saves before an update closes it. One handler; a second replaces the first. */
  onBeforeUpdate: (handler: () => Promise<void> | void): void => {
    beforeUpdate = handler;
  },

  /**
   * The application menu asking the page to go somewhere. One-way and
   * id-based: the menu is built in the main process and the renderer only
   * matches ids it knows, so the menu can never make the page do something it
   * has no command for.
   */
  onMenuCommand: (handler: (id: string) => void): void => {
    ipcRenderer.on('orderbook:menuCommand', (_event, id: string) => handler(id));
  },
});
