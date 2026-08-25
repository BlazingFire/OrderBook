/**
 * A one-way door from the services into a single connected Office Panel's
 * socket.
 *
 * The hub already imports the services — that is the direction commands travel.
 * Panel administration needs the opposite: rotating a secret or moving a
 * panel's data folder is something the *Master* initiates and the panel obeys.
 * Importing the hub from `panel.service.ts` to do that would close an import
 * cycle, so the hub registers this seam at startup instead and the service
 * asks for it by name.
 *
 * `null` when no hub is running (every unit test that does not stand one up),
 * which is why every caller has to handle "no link" rather than assume one.
 */

import type { ServerToClientEvents } from '@orderbook/shared';

/** Only the Master→panel events that carry an acknowledgement belong here. */
export type PanelRequest = 'panel:describe' | 'panel:credentials' | 'panel:setStoragePath';

export interface PanelLink {
  isConnected(panelId: string): boolean;
  /**
   * Emit one request to a panel and wait for its ack.
   *
   * Rejects when the panel is not connected, refuses, or says nothing within
   * the hub's timeout — the caller turns each into its own message, because
   * "offline", "refused" and "silent" need different advice on screen.
   */
  request<T>(panelId: string, event: PanelRequest, payload?: unknown): Promise<T>;
  /** Drop a panel's socket. Returns false when it was not connected. */
  disconnect(panelId: string): boolean;
  /** Fire-and-forget push, for events with no ack (`panel:revoked`). */
  notify(panelId: string, event: keyof ServerToClientEvents): boolean;
}

let link: PanelLink | null = null;

export function setPanelLink(next: PanelLink | null): void {
  link = next;
}

export function panelLink(): PanelLink | null {
  return link;
}
