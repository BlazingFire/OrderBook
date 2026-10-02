/**
 * What the shared `ReportsScreen` is allowed to reach on this panel: the
 * Office's own HTTP proxies of the Master's reports. Online only — the Office
 * answers a 503 with the Master unreachable, and the Master decides who may see
 * whose figures.
 */

import type { ReportsTransport } from '@orderbook/ui';

import { api } from './api';

export const reportsTransport: ReportsTransport = {
  options: (signal) => api.reportOptions(signal),
  table: (kind, query, signal) => api.reportTable(kind, query, signal),
  exportFile: (kind, query) => api.reportExport(kind, query),
};
