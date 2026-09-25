/**
 * The Office Panel's desktop entrypoint.
 *
 * The Master's twin — see `shell.ts` for the reasoning, which is identical.
 * The differences are all here: a different port, a different data directory,
 * no PostgreSQL to wait for so it comes up in a second rather than a minute,
 * and no auto-start, because a person opens this panel when they sit down at
 * it and a window somebody has to close every morning is not a feature. The
 * server's environment is in `lib/office-env.ts`, where a test can reach it.
 */

import { officeServerEnv } from './lib/office-env.js';
import { runPanelShell } from './shell.js';

runPanelShell({
  panel: 'office',
  productName: 'OrderBook Office Panel',
  port: Number(process.env.OFFICE_PORT ?? 4200),
  readyTimeoutMs: 60_000,
  autoStartByDefault: false,
  serverEnv: officeServerEnv,
});
