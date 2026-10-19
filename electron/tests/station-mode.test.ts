import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { backgroundThrottlingFor, parseStationMode } from '../lib/station-mode.js';

const shell = readFileSync(path.resolve(import.meta.dirname, '..', 'shell.ts'), 'utf8');
const preload = readFileSync(path.resolve(import.meta.dirname, '..', 'preload.cts'), 'utf8');

/** The body of one `ipcMain.handle` registration, up to the next one. */
function handlerBody(channel: string): string {
  const start = shell.indexOf(`ipcMain.handle('${channel}'`);
  expect(start, `${channel} is registered`).toBeGreaterThan(-1);
  const next = shell.indexOf('ipcMain.handle(', start + 10);
  return shell.slice(start, next === -1 ? undefined : next);
}

describe('parseStationMode', () => {
  it('turns station mode on for the boolean true and for nothing else', () => {
    expect(parseStationMode(true)).toBe(true);
    for (const value of [false, 1, 'true', 'on', {}, [], null, undefined, 0, Number.NaN]) {
      expect(parseStationMode(value)).toBe(false);
    }
  });
});

describe('backgroundThrottlingFor', () => {
  it('stops throttling a hidden window only while it is a print station', () => {
    expect(backgroundThrottlingFor(true)).toBe(false);
    expect(backgroundThrottlingFor(false)).toBe(true);
  });
});

describe('orderbook:setStationMode in shell.ts', () => {
  it('answers only the panel\'s own window, and decides from the validated boolean', () => {
    const body = handlerBody('orderbook:setStationMode');
    // The sender check is the panel window's, never a claim the page makes.
    expect(body).toMatch(/event\.sender !== mainWindow\.webContents/);
    expect(body).toContain('setBackgroundThrottling(backgroundThrottlingFor(parseStationMode(value)))');
  });

  it('is exposed by the preload as a single boolean, not a free-form call', () => {
    expect(preload).toContain("setStationMode: (on: boolean): Promise<boolean> =>");
    expect(preload).toContain("ipcRenderer.invoke('orderbook:setStationMode', on)");
  });

  it('saves straight to the Desktop with no dialog, in a series that never overwrites', () => {
    const body = handlerBody('orderbook:savePdfToDesktop');
    // Only the panel's own window may ask, like every print handler.
    expect(body).toMatch(/event\.sender !== mainWindow\?\.webContents/);
    // No dialog: the Desktop path plus the series name, then the write.
    expect(body).not.toContain('showSaveDialog');
    expect(body).toContain("app.getPath('desktop')");
    expect(body).toContain('desktopPdfName(');
    expect(preload).toContain("ipcRenderer.invoke('orderbook:savePdfToDesktop', options)");
  });
});

describe('silent printing for a station', () => {
  it('still prints silently only to a printer Windows lists, and every print handler checks the panel window', () => {
    const body = handlerBody('orderbook:printPage');
    expect(body).toMatch(/event\.sender !== mainWindow\?\.webContents/);
    expect(body).toContain('getPrintersAsync()');
    expect(body).toContain('printOptions(value, installed)');
    for (const channel of ['orderbook:listPrinters', 'orderbook:savePdf', 'orderbook:savePdfToDesktop', 'orderbook:setStationMode']) {
      expect(handlerBody(channel), channel).toMatch(/event\.sender !== (mainWindow\?\.webContents|window\.webContents|mainWindow\.webContents)/);
    }
  });
});
