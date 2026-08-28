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
  serverEnv: ({ dataDir, port, logFile }) => ({
    ORDERBOOK_OFFICE_DATA_DIR: dataDir,
    OFFICE_PORT: String(port),
    ORDERBOOK_LOG_FILE: logFile,
    // Beside the data directory, never inside it — this is the file that says
    // where the data directory is, so a storage move must not carry it along.
    ORDERBOOK_OFFICE_SETTINGS_FILE: path.join(path.dirname(dataDir), 'office-settings.env'),
  }),
});
