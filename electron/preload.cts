/**
 * The whole bridge between a panel's web UI and its desktop shell.
 *
 * `contextIsolation` is on, `nodeIntegration` off and `sandbox` on, so this is
 * the only surface the page ever sees — it gets a function that takes a path,
 * not a `spawn`. A page that could ask for anything to be run would make the
 * shell strictly more dangerous than the browser tab it replaces. The shell
 * additionally refuses any path outside the panel's own updates folder.
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

  getShellSettings: (): Promise<{ openAtLogin: boolean; logFile: string; standalone: boolean }> =>
    ipcRenderer.invoke('orderbook:getShellSettings') as Promise<{
      openAtLogin: boolean;
      logFile: string;
      standalone: boolean;
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
