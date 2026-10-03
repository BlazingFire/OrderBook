/**
 * The native choosers and the other window-only IPC handlers.
 *
 * `dialogTitle` and `dialogExtensions` run here directly. The sender checks
 * live in `shell.ts`, which imports `electron` and cannot run under this suite
 * (see `vitest.config.ts`), so they are read as text, like `shell-log.test.ts`
 * does: each handler that opens a chooser, prints or notifies must refuse a
 * sender that is not the panel's own window.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { DIALOG_TITLE_MAX, dialogExtensions, dialogTitle } from '../lib/dialog-options.js';

describe('dialogTitle', () => {
  it('uses the page title, trimmed and cut short', () => {
    expect(dialogTitle({ title: '  Choose the backup drive ' }, 'x')).toBe(
      'Choose the backup drive',
    );
    expect(dialogTitle({ title: 'y'.repeat(500) }, 'x')).toHaveLength(DIALOG_TITLE_MAX);
  });

  it('falls back for anything that is not a non-empty string', () => {
    for (const value of [undefined, null, 'title', {}, { title: 42 }, { title: '   ' }]) {
      expect(dialogTitle(value, 'Fallback')).toBe('Fallback');
    }
  });
});

describe('dialogExtensions', () => {
  it('keeps plain extension names, lowercased and without repeats', () => {
    expect(dialogExtensions({ extensions: ['ZIP', 'zip', ' obbackup '] })).toEqual([
      'zip',
      'obbackup',
    ]);
  });

  it('drops patterns, paths and non-strings', () => {
    expect(dialogExtensions({ extensions: ['*.zip', '../x', 'a/b', 7, '', 'zip'] })).toEqual([
      'zip',
    ]);
  });

  it('offers .zip when nothing usable is sent', () => {
    expect(dialogExtensions(undefined)).toEqual(['zip']);
    expect(dialogExtensions({ extensions: 'zip' })).toEqual(['zip']);
    expect(dialogExtensions({ extensions: ['*'] })).toEqual(['zip']);
  });
});

const shell = readFileSync(path.resolve(import.meta.dirname, '..', 'shell.ts'), 'utf8');

/** The body of one `ipcMain.handle(channel, …)` call, up to the next handler. */
function handlerBody(channel: string): string {
  const start = shell.indexOf(`ipcMain.handle('${channel}'`);
  expect(start, `${channel} is registered`).toBeGreaterThan(-1);
  const next = shell.indexOf('ipcMain.handle(', start + 1);
  return shell.slice(start, next === -1 ? undefined : next);
}

describe('window-only IPC handlers', () => {
  it.each([
    'orderbook:chooseDirectory',
    'orderbook:chooseFile',
    'orderbook:listPrinters',
    'orderbook:printPage',
    'orderbook:notify',
  ])('%s refuses a sender that is not the main window', (channel) => {
    expect(handlerBody(channel)).toMatch(
      /event\.sender !== (mainWindow\?\.webContents|window\.webContents)/,
    );
  });

  it('opens the choosers against the main window, so they are modal to it', () => {
    expect(handlerBody('orderbook:chooseDirectory')).toContain('dialog.showOpenDialog(window,');
    expect(handlerBody('orderbook:chooseFile')).toContain('dialog.showOpenDialog(window,');
    expect(handlerBody('orderbook:chooseFile')).toContain("properties: ['openFile']");
  });
});
