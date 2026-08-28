/**
 * The Master Panel's desktop entrypoint.
 *
 * Everything that is not a difference between the two panels lives in
 * `shell.ts`. The differences are all here: a port, a data directory variable,
 * how long a first run may take, and whether the panel starts with the PC.
 */

import path from 'node:path';

import { runPanelShell } from './shell.js';

runPanelShell({
  panel: 'master',
  productName: 'OrderBook Master Panel',
  port: Number(process.env.PORT ?? 4100),
  /** First run builds a PostgreSQL cluster; that is the slow one to allow for. */
  readyTimeoutMs: 180_000,
  /*
   * The Master is the machine every panel syncs through, so it comes up with
   * the PC rather than waiting for somebody to click something — otherwise
   * nobody opening OrderBook in the morning means every office panel sits
   * offline. Applied once, on first run; after that the operator owns it.
   */
  autoStartByDefault: true,
  serverEnv: ({ dataDir, port, logFile }) => ({
    ORDERBOOK_DATA_DIR: dataDir,
    PORT: String(port),
    ORDERBOOK_LOG_FILE: logFile,
    // Beside the data directory, never inside it — this is the file that says
    // where the data directory is, so a storage move must not carry it along.
    ORDERBOOK_MASTER_SETTINGS_FILE: path.join(path.dirname(dataDir), 'master-settings.env'),
  }),
});
