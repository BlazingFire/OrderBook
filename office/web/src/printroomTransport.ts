/**
 * What the shared Printroom screens reach on an Office Panel: its own server's
 * `/api/print-jobs` and `/api/print-stations` forwards (`api`), and a small
 * in-page bus the shell feeds from the event stream's `print` frames and from
 * every reconnect (`resync`).
 *
 * Every call needs the Master. With no link the server answers 503 and `api`
 * rejects with `code: 'unavailable'`, which the screens turn into "the Master is
 * not reachable"; the local Print button on a note keeps working regardless.
 */

import type { PrintEvent, PrintroomTransport } from '@orderbook/ui';

import { api } from './api';

const listeners = new Set<(event: PrintEvent) => void>();

/** Called by the shell for every `print` frame, and with `resync` whenever the stream or the link comes back. */
export function dispatchPrint(event: PrintEvent): void {
  for (const listener of [...listeners]) listener(event);
}

export const officePrintroomTransport: PrintroomTransport = {
  listJobs: (query) => api.printJobs(query),
  getJob: (id) => api.printJob(id),
  sendJob: (input) => api.sendPrintJob(input),
  markJob: (id, printed, printerName) => api.markPrintJob(id, printed, printerName),
  cancelJob: (id) => api.cancelPrintJob(id),
  // The panel's server relays the claim over its connection to the Master, which holds it.
  claimJob: (id) => api.claimPrintJob(id),
  listStations: () => api.printStations(),
  saveStation: (input) => api.savePrintStation(input),
  subscribe: (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
