/**
 * Settings → Leads on the Office Panel, booted whole in jsdom
 * (`panel-harness.ts` says how), because what it pins lives in the wiring:
 *
 *  · the follow-up default is the company's, read off the synced view through
 *    `resolveCompanyFeatures` — not a number the panel made up — and a new
 *    value arriving with the next snapshot replaces what the box shows;
 *  · a save goes to the panel's own `PUT /api/settings/:key`, which forwards it
 *    to the Master; it is offered only with `settings.manage`;
 *  · the lead sources are the `lead.sourcePlatform` option list, shown with
 *    `fields.view` and reloaded when a snapshot brings new option lists.
 *
 * docs/catalogue/CATALOGUE_MODEL.md §5.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { t } from '../src/i18n.js';
import {
  FakeEventSource,
  installBrowserStubs,
  json,
  loadApp,
  routeFetch,
  type Call,
} from './panel-harness.js';

const CONNECTION = {
  hasNetworkLink: true,
  interfaces: [],
  isPaired: true,
  panelName: 'Counter',
  state: 'connected',
  masterHost: '10.0.0.1',
  masterPort: 4100,
  companyName: 'Acme Ceramics',
  lastError: null,
  lastSyncedAt: null,
  masterVersion: null,
};

const SOURCE = {
  id: 'src-1',
  tenantId: 'tenant',
  listKey: 'lead.sourcePlatform',
  value: 'walk-in',
  label: 'Walk-in',
  sequence: 0,
  isActive: true,
  hex: null,
  deletedAt: null,
  createdAt: '2026-09-28T00:00:00.000Z',
  updatedAt: '2026-09-28T00:00:00.000Z',
  version: 1,
};

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    parties: [],
    products: [],
    categories: [],
    partyVariants: [],
    leads: [],
    orders: [],
    pipelines: [],
    optionLists: [],
    customFields: [],
    conflicts: [],
    dashboard: { asOf: '2026-09-24T00:00:00.000Z' },
    permissions: [],
    serverHlc: '0',
    serverTime: '2026-09-24T00:00:00.000Z',
    pendingCount: 0,
    ...overrides,
  };
}

async function sendSnapshot(view: ReturnType<typeof snapshot>): Promise<void> {
  await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
  await act(async () => {
    FakeEventSource.instances.at(-1)!.emit('snapshot', view);
  });
}

/** Boots the panel as somebody holding `permissions` and opens Settings → Leads. */
async function openLeadsTab(permissions: string[], view = snapshot()): Promise<Call[]> {
  const calls = routeFetch(({ method, url }) => {
    const path = url.split('?')[0] ?? url;
    if (path === '/api/connection') return json(CONNECTION);
    if (path === '/api/session') {
      return json({
        session: {
          userId: 'user-1',
          username: 'asha',
          displayName: 'Asha',
          roleId: null,
          roleName: 'Manager',
          roleTier: 'office',
          permissions,
          offline: false,
          signedInAt: '2026-09-24T00:00:00.000Z',
        },
        defaultLocale: 'en',
      });
    }
    if (path === '/api/sync') return json({ ...CONNECTION, pendingCount: 0, rejections: [] });
    if (path === '/api/fields/values') return json({ items: [SOURCE] });
    if (path === '/api/fields/usage') {
      return json({ listKey: 'lead.sourcePlatform', sources: ['leads'], values: [], unlisted: [] });
    }
    if (path === '/api/settings/leads.followUpDefaultDays' && method === 'PUT') return json([]);
    return undefined;
  });

  const App = await loadApp('office');
  render(<App />);
  await screen.findByRole('link', { name: t('footer.designSystem') });
  await sendSnapshot(view);

  fireEvent.click(screen.getByTitle(t('nav.settings')));
  fireEvent.click(await screen.findByRole('tab', { name: t('settings.tab.leads') }));
  return calls;
}

const FOLLOW_UP = t('setting.leads.followUpDefaultDays.label');

beforeEach(() => {
  installBrowserStubs();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Settings → Leads on the Office Panel', () => {
  it('shows the company follow-up default and saves a new one through the panel', async () => {
    const calls = await openLeadsTab(
      ['settings.manage', 'fields.view'],
      snapshot({ features: { followUpDefaultDays: 5 } }),
    );

    const box = await screen.findByRole<HTMLInputElement>('spinbutton', { name: FOLLOW_UP });
    expect(box.value).toBe('5');

    fireEvent.change(box, { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: t('common.save') }));

    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'PUT',
        url: '/api/settings/leads.followUpDefaultDays',
        body: { value: 7 },
      }),
    );

    // Not echoed locally: the value the Master stored comes back with the
    // snapshot the setting change forces.
    await sendSnapshot(snapshot({ features: { followUpDefaultDays: 7 } }));
    await waitFor(() => expect(box.value).toBe('7'));
  });

  it('lists the lead sources and reloads them when the option lists move', async () => {
    const calls = await openLeadsTab(['fields.view']);

    expect(await screen.findByText('Walk-in')).toBeTruthy();
    const reads = () => calls.filter((call) => call.url.startsWith('/api/fields/values')).length;
    const before = reads();

    await sendSnapshot(snapshot({ optionLists: [SOURCE] }));
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
  });

  it('shows the default without offering it, and no sources, to a reader who may change neither', async () => {
    const calls = await openLeadsTab([]);

    // No `features` on the view: the declared fallback, never a panel-made number.
    expect(await screen.findByText(`3 ${t('setting.unit.days')}`)).toBeTruthy();
    expect(screen.queryByRole('spinbutton', { name: FOLLOW_UP })).toBeNull();
    expect(screen.queryByText(t('settings.leads.sources.title'))).toBeNull();
    expect(calls.some((call) => call.url.startsWith('/api/fields/'))).toBe(false);
  });
});
