/**
 * What the Office Panel's server is started with, on top of the shell's own
 * environment (`serverEnv` in `shell.ts`).
 *
 * Its own module rather than a literal in `office.main.ts` so that a test can
 * hold it: `office.main.ts` starts the shell the moment it is imported, and
 * these are the lines a storage move depends on. Dropping the pointer's path
 * from here would leave every server-side test green and bring back the move
 * that reverts at the next restart — `electron/tests/office-env.test.ts` and
 * `office/tests/storage-path.test.ts` both start from this function instead.
 */

import path from 'node:path';

/** What the shell knows about this start of the server. */
export interface ServerEnvContext {
  dataDir: string;
  port: number;
  logFile: string;
  /** The shell's pointer, `office-location.json`, that `dataDir` was just read from. */
  locationFile: string;
}

export function officeServerEnv({
  dataDir,
  port,
  logFile,
  locationFile,
}: ServerEnvContext): NodeJS.ProcessEnv {
  return {
    ORDERBOOK_OFFICE_DATA_DIR: dataDir,
    OFFICE_PORT: String(port),
    ORDERBOOK_LOG_FILE: logFile,
    // The shell's record of where the data directory is. The server rewrites
    // it when the folder is moved, from the Master or from this panel's own
    // storage card: the folder above goes into the server's real environment,
    // which no settings file can override, so the next start only follows a
    // move recorded here (`relocateDataDir` in `office/src/config/paths.ts`).
    ORDERBOOK_OFFICE_LOCATION_FILE: locationFile,
    // Beside that pointer: one fixed path per machine, never inside the data
    // directory. It used to follow the data directory's parent, which put it
    // *inside* a folder moved to the root of a drive, and left any override
    // somebody had put in it behind once a move stuck. For the default folder
    // it is the same `office-settings.env` as ever.
    ORDERBOOK_OFFICE_SETTINGS_FILE: path.join(path.dirname(locationFile), 'office-settings.env'),
  };
}
