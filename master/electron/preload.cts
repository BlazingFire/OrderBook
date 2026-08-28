/**
 * The whole bridge between the panel's web UI and its desktop shell.
 *
 * One method, because there is exactly one thing the page cannot do for
 * itself: run a setup file and get out of its way. Finding an update,
 * downloading it and checking it all happen in the panel's own server, where
 * they can be tested without a window.
 *
 * `contextIsolation` is on and `nodeIntegration` off, so this is the only
 * surface the page ever sees — it gets a function that takes a path, not a
 * `spawn`. A page that could ask for anything to be run would make the shell
 * strictly more dangerous than the browser tab it replaces.
 *
 * CommonJS (`.cts`) deliberately: Electron preload scripts are not ESM.
 */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('orderbook', {
  panel: 'master',
  shellVersion: process.versions.electron,
  applyUpdate: (filePath: string): Promise<boolean> =>
    ipcRenderer.invoke('orderbook:applyUpdate', filePath) as Promise<boolean>,
});
