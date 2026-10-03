/**
 * The Master Panel's desktop entrypoint.
 *
 * Everything that is not a difference between the two panels lives in
 * `shell.ts`. The differences are all here: a port, a data directory variable,
 * how long a first run may take, and whether the panel starts with the PC.
 */

import { runPanelShell } from './shell.js';

runPanelShell({
  panel: 'master',
  productName: 'OrderBook Master Panel',
  appUserModelId: 'com.orderbook.master',
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
  /*
   * No settings file, unlike the Office's `ORDERBOOK_OFFICE_SETTINGS_FILE`:
   * the Office server moves its own data folder at runtime and records where
   * in that file, while the Master's folder is moved only by the shell
   * (`orderbook:setDataDir`), which records it in `master-location.json` and
   * passes the result as `ORDERBOOK_DATA_DIR`. Every variable here must be one
   * the Master reads (`electron/tests/server-env.test.ts`).
   */
  serverEnv: ({ dataDir, port, logFile }) => ({
    ORDERBOOK_DATA_DIR: dataDir,
    PORT: String(port),
    ORDERBOOK_LOG_FILE: logFile,
  }),
});
