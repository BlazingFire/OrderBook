/**
 * The Office Panel's desktop entrypoint.
 *
 * The Master's twin — see `shell.ts` for the reasoning, which is identical.
 * The differences are all here: a different port, a different data directory,
 * no PostgreSQL to wait for so it comes up in a second rather than a minute,
 * and no auto-start, because a person opens this panel when they sit down at
 * it and a window somebody has to close every morning is not a feature.
 */

import path from 'node:path';

import { runPanelShell } from './shell.js';

runPanelShell({
  panel: 'office',
  productName: 'OrderBook Office Panel',
  port: Number(process.env.OFFICE_PORT ?? 4200),
  readyTimeoutMs: 60_000,
  autoStartByDefault: false,
  serverEnv: ({ dataDir, port, logFile, locationFile }) => ({
    ORDERBOOK_OFFICE_DATA_DIR: dataDir,
    OFFICE_PORT: String(port),
    ORDERBOOK_LOG_FILE: logFile,
    // The shell's record of where the data directory is. The server rewrites
    // it when the folder is moved from the Master or the sign-in screen: the
    // folder above goes into the server's real environment, which no settings
    // file can override, so the next start only follows a move recorded here
    // (`relocateDataDir` in `office/src/config/paths.ts`).
    ORDERBOOK_OFFICE_LOCATION_FILE: locationFile,
    // Beside that pointer: one fixed path per machine, never inside the data
    // directory. It used to follow the data directory's parent, which put it
    // *inside* a folder moved to the root of a drive, and left any override
    // somebody had put in it behind once a move stuck. For the default folder
    // it is the same `office-settings.env` as ever.
    ORDERBOOK_OFFICE_SETTINGS_FILE: path.join(path.dirname(locationFile), 'office-settings.env'),
  }),
});
