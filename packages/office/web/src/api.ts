/**
 * Office Panel's local API. Every write here is forwarded by this panel's own
 * server to the Master — nothing is stored locally.
 */

import type {
  Lead,
  LeadInput,
  LeadStatus,
  Party,
  PartyInput,
  Product,
  ProductInput,
  SyncSnapshot,
} from '@orderbook/shared';

export interface ConnectionInfo {
  hasNetworkLink: boolean;
  interfaces: Array<{ name: string; address: string; broadcastAddress: string }>;
  isPaired: boolean;
  panelName: string;
  state: 'unpaired' | 'connecting' | 'connected' | 'disconnected';
  masterHost: string | null;
  masterPort: number | null;
  companyName: string | null;
  lastError: string | null;
  lastSyncedAt: string | null;
}

export interface DiscoveredMaster {
  masterUniqueId: string;
  companyName: string | null;
  lanIp: string;
  httpPort: number;
  acceptingPairing: boolean;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });

  if (response.status === 204) return undefined as T;

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error((body as { message?: string } | null)?.message ?? 'Request failed');
  }
  return body as T;
}

export const api = {
  connection: () => request<ConnectionInfo>('/api/connection'),
  scan: () => request<{ masters: DiscoveredMaster[] }>('/api/connection/scan', { method: 'POST' }),
  pairAuto: (panelName?: string) =>
    request<{ ok: true; companyName: string | null }>('/api/connection/pair/auto', {
      method: 'POST',
      body: JSON.stringify({ panelName }),
    }),
  pairManual: (input: {
    host: string;
    port: number;
    pairingPassword: string;
    masterUniqueId?: string;
    panelName?: string;
  }) =>
    request<{ ok: true; companyName: string | null }>('/api/connection/pair/manual', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  snapshot: () => request<SyncSnapshot>('/api/snapshot'),

  createParty: (input: PartyInput) =>
    request<Party>('/api/parties', { method: 'POST', body: JSON.stringify(input) }),
  createProduct: (input: ProductInput) =>
    request<Product>('/api/products', { method: 'POST', body: JSON.stringify(input) }),
  createLead: (input: LeadInput) =>
    request<Lead>('/api/leads', { method: 'POST', body: JSON.stringify(input) }),
  setLeadStatus: (id: string, status: LeadStatus) =>
    request<Lead>(`/api/leads/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) }),
};
