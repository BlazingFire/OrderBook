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

  /** A native folder chooser, for picking where the panel's data lives. */
  chooseDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke('orderbook:chooseDirectory') as Promise<string | null>,

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
  printPage: (options: { deviceName?: string }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('orderbook:printPage', options) as Promise<{ ok: boolean; error?: string }>,

  /** A system notification plus a taskbar flash, for a notice the operator should not miss. */
  notify: (notice: { title: string; body: string }): Promise<boolean> =>
    ipcRenderer.invoke('orderbook:notify', notice) as Promise<boolean>,

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
