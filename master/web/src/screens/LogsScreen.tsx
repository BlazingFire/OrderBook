/**
 * The Master's mount of the shared Logs screen (`ui/src/LogsScreen.tsx`),
 * answered from this Master's own `/api/logs` routes.
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

export function LogsScreen({
  permissions,
  search,
}: {
  permissions: string[];
  /** A person's id, from their screen's "Open in activity log". */
  search?: { q: string; nonce: number } | null;
}) {
  return <SharedLogsScreen permissions={permissions} transport={transport} search={search} />;
}
