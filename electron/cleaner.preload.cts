/**
 * The whole bridge between the clean-install page and the tool.
 *
 * Same rule as `preload.cts` next door and for a sharper reason: this tool
 * deletes a company's database. `contextIsolation` is on, `nodeIntegration`
 * off and `sandbox` on, so the page gets these six functions and nothing else
 * — no `spawn`, no `fs`. Every one of them validates its own arguments again
 * in the main process, because a renderer is not a place to keep a decision
 * that cannot be undone.
 *
 * CommonJS (`.cts`) deliberately: Electron preload scripts are not ESM.
 */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('cleaner', {
  /** Run the sweep in dry-run mode and report what is on this PC. */
  detect: (): Promise<unknown> => ipcRenderer.invoke('cleaner:detect'),

  chooseBackupFolder: (): Promise<string | null> =>
    ipcRenderer.invoke('cleaner:chooseBackupFolder') as Promise<string | null>,

  backup: (request: { into: string; sources: string[] }): Promise<unknown> =>
    ipcRenderer.invoke('cleaner:backup', request),

  /**
   * Erase. Takes the typed word rather than a boolean: the main process
   * checks it again, so "the user confirmed" is a fact the page carries, not
   * a state it claims to be in.
   */
  wipe: (request: { confirmation: string }): Promise<unknown> =>
    ipcRenderer.invoke('cleaner:wipe', request),

  /** Detect again, after the sweep, and report whatever survived. */
  verify: (): Promise<unknown> => ipcRenderer.invoke('cleaner:verify'),

  chooseSetupFile: (): Promise<string | null> =>
    ipcRenderer.invoke('cleaner:chooseSetupFile') as Promise<string | null>,

  checkSetupFile: (request: { setupPath: string }): Promise<unknown> =>
    ipcRenderer.invoke('cleaner:checkSetupFile', request),

  install: (request: { setupPath: string; accepted: boolean }): Promise<unknown> =>
    ipcRenderer.invoke('cleaner:install', request),

  /** Each line the running script prints, as it prints it. */
  onLine: (listener: (line: string) => void): void => {
    ipcRenderer.on('cleaner:line', (_event, line: string) => listener(line));
  },
});
