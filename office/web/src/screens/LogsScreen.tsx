/**
 * The Office mount of the shared Logs screen (`ui/src/LogsScreen.tsx`). This
 * panel keeps no copy of the log: its server forwards `/api/logs*` to the
 * Master and answers 503 while the Master is out of reach.
 */

import { LogsScreen as SharedLogsScreen, type LogsTransport } from '@orderbook/ui';

import { api } from '../api';

/** Built once, so the screen sees the same object on every render. */
const transport: LogsTransport = {
  logs: (query) => api.logs(query),
  logFacets: (range) => api.logFacets(range),
  verifyLogChain: () => api.verifyLogChain(),
  logsExportUrl: (query) => api.logsExportUrl(query),
};

export function LogsScreen({ permissions }: { permissions: string[] }) {
  return <SharedLogsScreen permissions={permissions} transport={transport} />;
}
