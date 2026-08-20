/** Thin wrapper over the Master's local HTTP API. */

import type {
  DashboardSummary,
  Lead,
  LeadInput,
  LeadStatus,
  MasterIdentity,
  OfficePanelWithPresence,
  Paginated,
  Party,
  PartyInput,
  Product,
  ProductCategory,
  ProductInput,
  StorageUsage,
  User,
} from '@orderbook/shared';

export class ApiError extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    credentials: 'same-origin',
  });

  if (response.status === 204) return undefined as T;

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError((body as { message?: string } | null)?.message ?? 'Request failed');
  }
  return body as T;
}

export interface FirstRunCredentials {
  masterUniqueId: string;
  username: string;
  password: string;
  pairingPassword: string;
  lanIps: string[];
  port: number;
}

export const api = {
  setupStatus: () => request<{ setupComplete: boolean }>('/api/setup/status'),
  initialize: (companyName: string) =>
    request<FirstRunCredentials>('/api/setup/initialize', {
      method: 'POST',
      body: JSON.stringify({ companyName }),
    }),
  identity: () => request<MasterIdentity>('/api/setup/identity'),

  signIn: (username: string, password: string) =>
    request<{ user: User; sessionToken: string }>('/api/auth/sign-in', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  signOut: () => request<void>('/api/auth/sign-out', { method: 'POST' }),
  me: () => request<{ user: User; sessionToken: string }>('/api/auth/me'),

  dashboard: () => request<DashboardSummary>('/api/dashboard'),
  storage: () => request<StorageUsage>('/api/storage'),

  panels: () => request<{ panels: OfficePanelWithPresence[] }>('/api/panels'),
  openPairingWindow: () => request<{ closesAt: number }>('/api/panels/pairing-window/open', { method: 'POST' }),
  closePairingWindow: () => request<void>('/api/panels/pairing-window/close', { method: 'POST' }),
  revokePanel: (id: string) => request<void>(`/api/panels/${id}/revoke`, { method: 'POST' }),
  renamePanel: (id: string, name: string) =>
    request<void>(`/api/panels/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),

  parties: (search?: string) =>
    request<Paginated<Party>>(`/api/parties${search ? `?search=${encodeURIComponent(search)}` : ''}`),
  createParty: (input: PartyInput) =>
    request<Party>('/api/parties', { method: 'POST', body: JSON.stringify(input) }),

  products: (search?: string) =>
    request<Paginated<Product>>(`/api/products${search ? `?search=${encodeURIComponent(search)}` : ''}`),
  createProduct: (input: ProductInput) =>
    request<Product>('/api/products', { method: 'POST', body: JSON.stringify(input) }),
  categories: () => request<{ categories: ProductCategory[] }>('/api/categories'),

  leads: (statuses?: LeadStatus[]) =>
    request<Paginated<Lead>>(`/api/leads${statuses?.length ? `?statuses=${statuses.join(',')}` : ''}`),
  createLead: (input: LeadInput) =>
    request<Lead>('/api/leads', { method: 'POST', body: JSON.stringify(input) }),
  setLeadStatus: (id: string, status: LeadStatus) =>
    request<Lead>(`/api/leads/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) }),
};
