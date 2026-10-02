/**
 * What the shared `PartyImportControls` is allowed to reach on this panel: the
 * Office's own HTTP proxies of the Master's party import and export. Online
 * only — the Office answers a 503 with the Master unreachable.
 */

import type { PartyImportTransport } from '@orderbook/ui';

import { api } from './api';

export const partyImportTransport: PartyImportTransport = {
  partyImportTemplate: (format) => api.partyImportTemplate(format),
  exportParties: (format) => api.exportParties(format),
  importParties: (file, options) => api.importParties(file, options),
};
