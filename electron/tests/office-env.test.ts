/**
 * What the desktop shell starts the Office Panel's server with.
 *
 * Held here rather than through `office.main.ts`, which starts the shell the
 * moment it is imported. These are the lines a storage move depends on: the
 * shell reads the data folder from its pointer before every start, and a move
 * made while the server runs only survives the next start if the server was
 * told where that pointer is. `office/tests/storage-path.test.ts` starts the
 * real server config from this same environment and moves it.
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { officeServerEnv } from '../lib/office-env.js';

const appData = path.resolve('/users/asha/AppData/Roaming');
const locationFile = path.join(appData, 'OrderBook', 'office-location.json');

function envFor(dataDir: string): NodeJS.ProcessEnv {
  return officeServerEnv({
    dataDir,
    port: 4200,
    logFile: path.join(dataDir, 'logs', 'office.log'),
    locationFile,
  });
}

describe('the Office server’s environment', () => {
  it('tells the server where the shell keeps its pointer, so a move can rewrite it', () => {
    expect(envFor(path.join(appData, 'OrderBook', 'office')).ORDERBOOK_OFFICE_LOCATION_FILE).toBe(
      locationFile,
    );
  });

  it('keeps the settings file beside that pointer, wherever the data has been moved', () => {
    const settings = path.join(appData, 'OrderBook', 'office-settings.env');

    // The default folder: the same file it always was.
    expect(envFor(path.join(appData, 'OrderBook', 'office')).ORDERBOOK_OFFICE_SETTINGS_FILE).toBe(
      settings,
    );
    // A moved one. Following the data folder's parent put this file inside the
    // folder the panel was moved to — at the top of the drive, for `D:\Office`.
    expect(envFor(path.resolve('/d/Office')).ORDERBOOK_OFFICE_SETTINGS_FILE).toBe(settings);
  });

  it('passes the folder, port and log the shell chose', () => {
    const dataDir = path.resolve('/d/Office');

    expect(envFor(dataDir)).toMatchObject({
      ORDERBOOK_OFFICE_DATA_DIR: dataDir,
      OFFICE_PORT: '4200',
      ORDERBOOK_LOG_FILE: path.join(dataDir, 'logs', 'office.log'),
    });
  });
});
