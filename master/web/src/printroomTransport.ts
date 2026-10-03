/**
 * What the shared Printroom screens reach on the Master's own browser: its
 * `/api/print-jobs` and `/api/print-stations` routes through `api`, and a small
 * in-page bus the shell feeds from the socket's `print:changed` (and from a
 * reconnect, as `resync`).
 *
 * A claim is the one call that is not REST. The Master holds a claim by the
 * connection that made it, so the Master PC's window claims over its own socket
 * (`print:claim`), and the claim is released when that window closes.
 */

import type { PrintJob } from '@orderbook/shared';
import { t, type PrintEvent, type PrintroomTransport } from '@orderbook/ui';
import type { Socket } from 'socket.io-client';

import { ApiError, api } from './api';

const listeners = new Set<(event: PrintEvent) => void>();

/** Called by the shell for every `print:changed`, and with `resync` after a reconnect. */
export function dispatchPrint(event: PrintEvent): void {
  for (const listener of [...listeners]) listener(event);
}

let link: Socket | null = null;

/** The shell hands over the open socket (or null when it closes), so a claim can ride on it. */
export function attachPrintSocket(socket: Socket | null): void {
  link = socket;
}

/** How long a claim waits for the Master before it counts as unreachable (ms). */
const CLAIM_TIMEOUT_MS = 15_000;

type ClaimAck =
  | { ok: true; data: PrintJob | null }
  | { ok: false; error: string; code?: string; messageKey?: never; params?: never };

export const masterPrintroomTransport: PrintroomTransport = {
  listJobs: (query) => api.printJobs(query),
  getJob: (id) => api.printJob(id),
  sendJob: (input) => api.sendPrintJob(input),
  markJob: (id, printed, printerName) => api.markPrintJob(id, printed, printerName),
  cancelJob: (id) => api.cancelPrintJob(id),
  claimJob: (id) =>
    new Promise<PrintJob | null>((resolve, reject) => {
      if (!link?.connected) {
        reject(new ApiError(t('error.unavailable'), 'unavailable'));
        return;
      }
      link.timeout(CLAIM_TIMEOUT_MS).emit('print:claim', id, (timedOut: Error | null, result?: ClaimAck) => {
        if (timedOut || !result) {
          reject(new ApiError(t('error.unavailable'), 'unavailable'));
        } else if (result.ok) {
          resolve(result.data);
        } else {
          reject(new ApiError(result.error, result.code ?? 'master_command_failed'));
        }
      });
    }),
  listStations: () => api.printStations(),
  saveStation: (input) => api.savePrintStation(input),
  subscribe: (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
