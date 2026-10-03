/**
 * The Office Panel's shell, booted whole in jsdom (`panel-harness.ts` says
 * how). Each group below is a defect somebody could only have found by
 * clicking, which is why none of them was caught before:
 *
 *  · the footer's "Design system" link opened the gallery for one frame — the
 *    `hashchange` it caused was read as "no route" and closed it again;
 *  · Alt+N reached screens the sidebar does not offer the signed-in person;
 *  · "See what was refused" on the refusal toast landed a salesperson on the
 *    Dashboard, because the screen that lists refusals was not theirs to open
 *    — and, pressed from the gallery, left them on the gallery;
 *  · the screen somebody was on outlived their session, so whoever signed in
 *    next at that window started on it, whether it was theirs to open or not;
 *  · a saved lead was still on the New lead form the next time it opened, one
 *    Save away from being queued twice;
 *  · the packaging "required" marker stayed up with the company switch off;
 *  · Reset asked through the browser's own `window.confirm`;
 *  · the order weight override was re-sent on every blur, edited or not, and
 *    a typed "1.2.3" crossed the wire as `null` and cleared it;
 *  · a panel whose own server could not be reached said "Request cancelled"
 *    on the splash, in English, rather than that it could not reach it.
 */

import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LONG_OFFLINE_MS, deviceCodeFromSeed, formatTemporaryId } from '@orderbook/shared';

import { formatElapsed } from '../src/format.js';
import { t } from '../src/i18n.js';
import { publishSessionEnded } from '../src/sessionEnded.js';
import {
  FakeEventSource,
  installBrowserStubs,
  json,
  loadApi,
  loadApp,
  pressAltDigit,
  pressAltDigitUntil,
  routeFetch,
  topbarTitle,
  wait,
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

const PARTY = {
  id: 'party-1',
  partyCode: 'P-001',
  name: 'Sharma Traders',
  city: 'Morbi',
  phone: '98250 00000',
};

const CATEGORY = { id: 'cat-1', name: 'ONE PIECE TOILET' };

const PRODUCT = {
  id: 'prod-1',
  name: 'Aqua Closet',
  categoryId: CATEGORY.id,
  categoryName: CATEGORY.name,
  alias: null,
  size: null,
  multiColour: false,
  variants: [{ id: 'var-1', label: 'White', code: 'AQ-W', weightKg: 30, isActive: true }],
};

const ORDER_PIPELINE = {
  id: 'pipe-orders',
  kind: 'order',
  name: 'Orders',
  stages: [{ id: 'stage-new', name: 'Confirmed', sequence: 1, isDefault: true, isTerminal: false }],
};

const ORDER = {
  id: 'ORD-1',
  partyId: PARTY.id,
  partyName: PARTY.name,
  leadId: null,
  stageId: 'stage-new',
  stageName: 'Confirmed',
  items: [],
  reservations: [],
  timeline: [],
  totalWeightKg: 120,
  totalWeightKgOverride: 150,
  weightSource: 'manual',
  linesWithoutWeight: 0,
  dispatchedAt: null,
  sync: { hlc: 'h1' },
};

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    parties: [PARTY],
    products: [PRODUCT],
    categories: [CATEGORY],
    partyVariants: [],
    leads: [],
    orders: [],
    stock: [],
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

interface Boot {
  permissions: string[];
  view?: Record<string, unknown>;
  /** What `POST /api/sync/flush` refuses. */
  refusals?: Array<{ mutationId: string; entityId: string; error: string }>;
  /** Asked first; `undefined` falls through to the answers below. */
  route?: (call: Call) => Response | Promise<Response> | undefined;
}

/** The signed-in person `/api/session` and a sign-in both answer with. */
function panelSession(permissions: string[]) {
  return {
    userId: 'user-1',
    username: 'asha',
    displayName: 'Asha',
    roleId: null,
    roleName: 'Sales',
    roleTier: 'office',
    permissions,
    offline: false,
    signedInAt: '2026-09-24T00:00:00.000Z',
  };
}

async function boot({ permissions, view = {}, refusals = [], route }: Boot): Promise<Call[]> {
  let held: typeof refusals = [];
  const calls = routeFetch((call) => {
    const answer = route?.(call);
    if (answer) return answer;
    const { method, url } = call;
    const path = url.split('?')[0] ?? url;
    if (path === '/api/connection') return json(CONNECTION);
    if (path === '/api/session') {
      return json({ session: panelSession(permissions), defaultLocale: 'en' });
    }
    if (path === '/api/sync') return json({ ...CONNECTION, pendingCount: 0, rejections: held });
    // Answered for every test: `api.ts` shares one in-flight GET per path across
    // the file, so a bell read left hanging by one test would swallow the next's.
    if (path === '/api/notifications') return json({ items: [], unreadCount: 0 });
    if (path === '/api/sync/flush' && method === 'POST') {
      held = refusals;
      return json({
        pushed: 1,
        applied: 0,
        merged: 0,
        rejected: refusals.length,
        rejections: refusals,
        remaining: 0,
      });
    }
    if (path === '/api/sync/rejections/acknowledge' && method === 'POST') {
      held = [];
      return json({ rejections: [] });
    }
    if (path === '/api/pick/party') return json({ items: [PARTY], truncated: false });
    if (path === '/api/pick/category') return json({ items: [CATEGORY], truncated: false });
    if (path === '/api/pick/product') return json({ items: [PRODUCT], truncated: false });
    if (path === '/api/leads' && method === 'POST') {
      return json({ queued: true, id: 'L-TMP-1', mutationId: 'mut-1', pendingCount: 1 });
    }
    if (path.startsWith('/api/orders/') && method === 'PUT') {
      return json({ queued: true, id: ORDER.id, mutationId: 'mut-2', pendingCount: 1 });
    }
    return undefined;
  });

  const App = await loadApp('office');
  render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  await screen.findByRole('link', { name: t('footer.designSystem') });
  await sendSnapshot(snapshot(view));
  return calls;
}

/**
 * The Master's view, down the panel's event stream — once there is one.
 *
 * The panel opens the stream in an effect, and React can put the shell on
 * screen before it has run that effect: the footer is there, the stream is
 * not. A snapshot sent then reached nobody, and every screen went on waiting
 * for a first sync that never came — on a loaded machine that was a New lead
 * form, an order row or a pending count that never appeared, in whichever
 * test lost the race.
 */
async function sendSnapshot(view: ReturnType<typeof snapshot>): Promise<void> {
  await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
  await act(async () => {
    FakeEventSource.instances.at(-1)!.emit('snapshot', view);
  });
}

beforeEach(() => {
  installBrowserStubs();
});

/** The topbar's own New lead button — the Leads board has one of its own. */
function newLeadButton(): HTMLElement {
  return within(document.querySelector<HTMLElement>('.ob-topbar')!).getByRole('button', {
    name: t('action.newLead'),
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as { orderbook?: unknown }).orderbook;
});

/** The panel's own lead form, as far as a draft card with one quantity typed. */
async function draftOneProduct(): Promise<void> {
  // The first test to open the New lead screen also pays for compiling it,
  // which under a full run takes longer than `findBy`'s one-second default.
  const partyBox = await screen.findByLabelText(
    t('lead.add.party.search'),
    {},
    { timeout: 10_000 },
  );
  // The party list appears only once something is typed.
  fireEvent.change(partyBox, { target: { value: 'Sha' } });
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(PARTY.name) }));

  const search = screen.getByLabelText(t('lead.add.products.searchLabel'));
  fireEvent.focus(search);
  fireEvent.mouseDown(await screen.findByRole('button', { name: CATEGORY.name }));
  fireEvent.mouseDown(await screen.findByRole('button', { name: new RegExp(PRODUCT.name) }));

  fireEvent.change(await screen.findByLabelText(`${t('lead.add.draft.col.quantity')} — White`), {
    target: { value: '5' },
  });
}

describe('the event stream', () => {
  it('stays one stream when the link reports it is connected', async () => {
    await boot({ permissions: ['leads.view'] });
    const opened = FakeEventSource.opened;

    // A connect makes the panel re-read the session, which hands back a new
    // object. Keyed on that object, the stream closed and reopened on every
    // connect — and each reopen connected again: a loop against the server.
    await act(async () => {
      FakeEventSource.instances.at(-1)!.emit('status', { state: 'connected' });
      await wait(50);
    });

    expect(FakeEventSource.opened).toBe(opened);
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});

describe('the link to the Master (1.3)', () => {
  const MINUTE = 60_000;
  const footerSync = () => document.querySelector('.ob-footer-sync')?.textContent ?? '';

  /** One `status` frame, as the panel's server sends it when the link changes. */
  async function status(frame: Record<string, unknown>): Promise<void> {
    await act(async () => {
      FakeEventSource.instances.at(-1)!.emit('status', frame);
      await wait(0);
    });
  }

  /** Stands in for the desktop shell's bridge; a browser tab has none. */
  function desktopShell() {
    const notify = vi.fn(async () => true);
    (window as { orderbook?: unknown }).orderbook = {
      shellVersion: 'test',
      applyUpdate: async () => false,
      notify,
    };
    return notify;
  }

  it('reads Catching up until what was missed is in, then Synced, then Offline', async () => {
    await boot({ permissions: ['leads.view'] });

    // Already connected, so no state in the frame: a move to connected re-reads
    // `/api/connection`, which this test's server answers without the field.
    await status({ catchingUp: true });
    expect(footerSync()).toBe(t('sync.catchingUp'));

    await status({ catchingUp: false });
    expect(footerSync()).toBe(t('sync.synced'));

    await status({ state: 'disconnected', disconnectedSince: new Date().toISOString() });
    expect(footerSync()).toBe(t('sync.offline'));
  });

  it('says in the sync popover since when, and for how long, it has been offline', async () => {
    await boot({ permissions: ['leads.view'] });
    await status({
      state: 'disconnected',
      disconnectedSince: new Date(Date.now() - 5 * MINUTE).toISOString(),
    });

    await act(async () => {
      fireEvent.click(document.querySelector<HTMLElement>('.ob-footer-sync')!);
      await wait(0);
    });

    const since = screen.getByText(t('office.sync.offlineSince'));
    expect(since.nextElementSibling?.textContent).toContain(
      `(${formatElapsed(5 * MINUTE)})`,
    );
  });

  it('does not let the Dashboard say "All synced" while offline', async () => {
    // One record, or the Dashboard is its empty state and has no cards.
    await boot({ permissions: ['leads.view'], view: { orders: [ORDER] } });
    await pressAltDigitUntil(2, t('nav.dashboard'));
    expect(screen.getByText(t('dashboard.sync.allSynced'))).toBeTruthy();

    await status({ state: 'disconnected', disconnectedSince: new Date().toISOString() });

    expect(screen.queryByText(t('dashboard.sync.allSynced'))).toBeNull();
    const tile = screen.getByText(t('dashboard.sync.title')).closest('.ob-stattile')!;
    expect(within(tile as HTMLElement).getByText(t('sync.offline'))).toBeTruthy();
  });

  it('after an hour offline: one banner, one bell entry and one desktop notice per episode', async () => {
    const notify = desktopShell();
    await boot({ permissions: ['leads.view'] });
    const since = new Date().toISOString();

    // Only the hour is faked. Nothing below may wait on a timer meanwhile.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      await act(async () => {
        FakeEventSource.instances.at(-1)!.emit('status', {
          state: 'disconnected',
          disconnectedSince: since,
        });
      });
      expect(screen.queryByText(t('office.link.offlineLongTitle'))).toBeNull();
      expect(notify).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(LONG_OFFLINE_MS);
      });
    } finally {
      vi.useRealTimers();
    }

    expect(await screen.findByText(t('office.link.offlineLongTitle'))).toBeTruthy();
    expect(screen.getByRole('button', { name: t('notification.unreadLabel', { count: 1 }) })).toBeTruthy();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: t('office.link.offlineLongTitle') }),
    );

    // More frames in the same episode do not notify again.
    await status({ state: 'disconnected', disconnectedSince: since, hasNetworkLink: false });
    expect(notify).toHaveBeenCalledTimes(1);

    // The link back ends the episode, and the banner with it.
    await status({ state: 'connected', disconnectedSince: null, hasNetworkLink: true });
    expect(screen.queryByText(t('office.link.offlineLongTitle'))).toBeNull();
  });

  it('shows the clock difference only past two minutes, and a Master that does not know this panel', async () => {
    await boot({ permissions: ['leads.view'] });

    await status({ clockSkewMs: 90_000 });
    expect(screen.queryByText(t('office.link.clockSkew', { duration: formatElapsed(90_000) }))).toBeNull();

    await status({ clockSkewMs: -5 * MINUTE });
    expect(
      screen.getByText(t('office.link.clockSkew', { duration: formatElapsed(5 * MINUTE) })),
    ).toBeTruthy();

    await status({ state: 'disconnected', notRecognised: true });
    expect(screen.getByText(t('office.link.notRecognised', { host: '10.0.0.1' }))).toBeTruthy();
  });

  it('re-reads the bell on a pushed notice and when the stream reopens, on the same stream', async () => {
    const notify = desktopShell();
    const calls = await boot({ permissions: ['leads.view'] });
    const reads = () => calls.filter((call) => call.url.split('?')[0] === '/api/notifications').length;
    await waitFor(() => expect(reads()).toBeGreaterThan(0));
    const opened = FakeEventSource.opened;

    let before = reads();
    await act(async () => {
      FakeEventSource.instances.at(-1)!.emit('notification', {
        id: 'n-1',
        kind: 'panel.offlineLong',
        params: { panel: 'Counter' },
        link: { kind: 'panel', id: 'panel-1' },
        createdAt: new Date().toISOString(),
        readAt: null,
        forUserId: 'user-1',
      });
      await wait(0);
    });
    expect(reads()).toBeGreaterThan(before);
    expect(notify).toHaveBeenCalledWith({
      title: t('notification.title'),
      body: t('notification.panel.offlineLong', { panel: 'Counter' }),
    });

    before = reads();
    await act(async () => {
      FakeEventSource.instances.at(-1)!.emit('error', {});
      FakeEventSource.instances.at(-1)!.emit('open', {});
      await wait(0);
    });
    expect(reads()).toBeGreaterThan(before);
    expect(FakeEventSource.opened).toBe(opened);
  });
});

describe('where a person lands', () => {
  it('starts an office-tier person on Basic Home, before any snapshot', async () => {
    routeFetch(({ url }) => {
      const path = url.split('?')[0] ?? url;
      if (path === '/api/connection') return json(CONNECTION);
      if (path === '/api/session') {
        return json({ session: panelSession(['leads.view']), defaultLocale: 'en' });
      }
      if (path === '/api/sync') return json({ ...CONNECTION, pendingCount: 0, rejections: [] });
      return undefined;
    });
    const App = await loadApp('office');
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    await screen.findByRole('link', { name: t('footer.designSystem') });

    // No snapshot has been sent: Basic Home reads only the sidebar.
    expect(topbarTitle()).toBe(t('nav.basicHome'));
    const work = within(screen.getByRole('region', { name: t('nav.work') }));
    expect(work.getByRole('button', { name: new RegExp(`^${t('nav.leads')}`) })).toBeTruthy();
  });

  it('starts an admin-tier person on the Dashboard', async () => {
    await boot({
      permissions: ['leads.view'],
      route: ({ url }) =>
        url.split('?')[0] === '/api/session'
          ? json({
              session: { ...panelSession(['leads.view']), roleTier: 'admin' },
              defaultLocale: 'en',
            })
          : undefined,
    });

    expect(topbarTitle()).toBe(t('nav.dashboard'));
  });
});

describe('the sign-in screen', () => {
  it("shows this PC's device code", async () => {
    routeFetch(({ url }) => {
      const path = url.split('?')[0] ?? url;
      if (path === '/api/connection') return json({ ...CONNECTION, deviceCode: 'K7Q' });
      if (path === '/api/session') return json({ session: null, defaultLocale: 'en' });
      return undefined;
    });
    const App = await loadApp('office');
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );

    expect(await screen.findByText('K7Q')).toBeTruthy();
    expect(screen.getByText(new RegExp(t('signin.deviceCode')))).toBeTruthy();
  });
});

describe('the splash', () => {
  it("says this panel's server could not be reached when the request never got there", async () => {
    routeFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    const App = await loadApp('office');
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );

    expect(await screen.findByText(t('splash.error.unreachable'))).toBeTruthy();
  });
});

describe('a request that ends without an answer', () => {
  it('is "aborted" when its own caller cancelled it', async () => {
    // What `CatalogScreen` drops quietly when a newer search replaces a load.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('The operation was aborted.', 'AbortError')),
            );
          }),
      ),
    );
    const api = await loadApi('office');
    const controller = new AbortController();

    const pending = api.pick('party', { term: 'sha', signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      code: 'aborted',
      message: t('error.requestCancelled'),
    });
  });

  it('is a failure, not a cancel, when it never reached the server', async () => {
    routeFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    const api = await loadApi('office');

    await expect(api.pick('party', { term: 'sha' })).rejects.toMatchObject({
      code: 'internal_error',
      message: t('error.requestFailed'),
    });
  });
});

describe('the design-system gallery', () => {
  it('stays open after the link it was opened from changes the hash', async () => {
    await boot({ permissions: ['leads.view'] });

    // What a click on the footer link does in a browser: the handler, then the
    // hash, then `hashchange`.
    await act(async () => {
      fireEvent.click(screen.getByRole('link', { name: t('footer.designSystem') }));
      window.location.hash = '#/gallery';
      await wait(0);
    });

    expect(topbarTitle()).toBe(t('footer.designSystem'));
  });

  it('opens when the panel is loaded at #/gallery', async () => {
    window.history.replaceState(null, '', '/#/gallery');
    await boot({ permissions: ['leads.view'] });

    expect(topbarTitle()).toBe(t('footer.designSystem'));
  });
});

describe('Alt+N', () => {
  it('does not open a screen the sidebar does not offer', async () => {
    // No `leads.view`, so no Leads item — Alt+3 is the Leads shortcut.
    await boot({ permissions: ['orders.view'] });
    await pressAltDigitUntil(4, t('orders.filter.allStages'));

    await act(async () => pressAltDigit(3));

    expect(topbarTitle()).toBe(t('orders.filter.allStages'));
    expect(document.querySelector('.ob-topbar')?.textContent).not.toContain(t('action.newLead'));
  });

  it('still opens a screen the sidebar does offer', async () => {
    await boot({ permissions: ['orders.view'] });

    await pressAltDigitUntil(4, t('orders.filter.allStages'));
  });

  it('opens Basic Home on Alt+1 and Settings on Alt+9', async () => {
    await boot({ permissions: ['orders.view'] });

    // Settings folds its tabs, so the title names the tab it opens on.
    await pressAltDigitUntil(9, t('settings.tab.appearance'));
    await pressAltDigitUntil(1, t('nav.basicHome'));
  });
});

describe('Reports', () => {
  const OPTIONS = {
    kinds: ['dispatches', 'by-user'],
    subjects: null,
    canExport: false,
  };
  const TABLE = {
    kind: 'dispatches',
    range: { period: 'last6Months', fromDate: '2026-05-01', toDateExclusive: '2026-11-01', months: ['2026-05', '2026-10'], timeZone: 'Asia/Kolkata' },
    subject: { id: 'user-1', name: 'Asha' },
    columns: [
      { key: 'month', labelToken: 'reports.column.month', unit: 'text' },
      { key: 'orderCount', labelToken: 'reports.column.orderCount', unit: 'count' },
    ],
    rows: [{ month: '2026-10', orderCount: 3 }],
    totals: { orderCount: 3 },
    rowCount: 1,
    truncated: false,
    sections: [],
  };

  function reportRoutes(call: Call): Response | undefined {
    const path = call.url.split('?')[0] ?? call.url;
    if (path === '/api/reports/options') return json(OPTIONS);
    if (path.startsWith('/api/reports/table/')) return json(TABLE);
    return undefined;
  }

  it('is a Work row for somebody with reports.view, and opens the first kind from the Master', async () => {
    const calls = await boot({ permissions: ['reports.view'], route: reportRoutes });

    const work = within(screen.getByRole('region', { name: t('nav.work') }));
    await act(async () => {
      fireEvent.click(work.getByRole('button', { name: new RegExp(`^${t('nav.reports')}`) }));
    });

    expect(await screen.findByText('2026-10')).toBeTruthy();
    const asked = calls.map((call) => call.url);
    expect(asked).toContain('/api/reports/options');
    expect(asked.some((url) => url.startsWith('/api/reports/table/dispatches'))).toBe(true);
    // The sidebar opens it on the first kind on offer, and the title says which.
    expect(document.querySelector('.ob-topbar')?.textContent).toContain(t('reports.kind.dispatches'));
  });

  it('asks again after every change the Master sends, even one that leaves the record counts as they were', async () => {
    const calls = await boot({ permissions: ['reports.view'], route: reportRoutes });
    const work = within(screen.getByRole('region', { name: t('nav.work') }));
    await act(async () => {
      fireEvent.click(work.getByRole('button', { name: new RegExp(`^${t('nav.reports')}`) }));
    });
    await screen.findByText('2026-10');

    const tableCalls = (): number => calls.filter((call) => call.url.startsWith('/api/reports/table/')).length;
    const change = { entity: 'party', action: 'updated', id: 'PT0000000001', payload: { id: 'PT0000000001', name: 'Shah', city: 'Morbi' } };

    // The first change adds a record; the second edits it in place and moves no count.
    for (let round = 0; round < 2; round += 1) {
      const before = tableCalls();
      await act(async () => {
        FakeEventSource.instances.at(-1)!.emit('change', change);
      });
      await waitFor(() => expect(tableCalls()).toBe(before + 1), { timeout: 2000 });
    }
  });

  it('offers the PDF preview only while the Master is reachable', async () => {
    const calls = await boot({
      permissions: ['reports.view', 'reports.export'],
      route: (call) =>
        call.url.split('?')[0] === '/api/reports/options' ? json({ ...OPTIONS, canExport: true }) : reportRoutes(call),
    });
    expect(calls.length).toBeGreaterThan(0);
    const work = within(screen.getByRole('region', { name: t('nav.work') }));
    await act(async () => {
      fireEvent.click(work.getByRole('button', { name: new RegExp(`^${t('nav.reports')}`) }));
    });
    await screen.findByText('2026-10');
    expect(screen.getByRole('link', { name: t('reports.previewPdf') })).toBeTruthy();

    await act(async () => {
      FakeEventSource.instances.at(-1)!.emit('status', { state: 'disconnected', disconnectedSince: new Date().toISOString() });
      await wait(0);
    });
    expect(screen.queryByRole('link', { name: t('reports.previewPdf') })).toBeNull();

    await act(async () => {
      FakeEventSource.instances.at(-1)!.emit('status', { state: 'connected', disconnectedSince: null });
      await wait(0);
    });
    expect(await screen.findByRole('link', { name: t('reports.previewPdf') })).toBeTruthy();
  });

  it('does not ask again for a change to something no report reads', async () => {
    const calls = await boot({ permissions: ['reports.view'], route: reportRoutes });
    const work = within(screen.getByRole('region', { name: t('nav.work') }));
    await act(async () => {
      fireEvent.click(work.getByRole('button', { name: new RegExp(`^${t('nav.reports')}`) }));
    });
    await screen.findByText('2026-10');

    const tableCalls = (): number => calls.filter((call) => call.url.startsWith('/api/reports/table/')).length;
    const before = tableCalls();
    await act(async () => {
      FakeEventSource.instances.at(-1)!.emit('change', { entity: 'option_list', action: 'updated', id: 'OL0000000001', payload: {} });
    });
    // Let any wrongly scheduled fetch land before counting.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(tableCalls()).toBe(before);
  });

  it('is not offered without reports.view, nor when the company has switched it off for the Office tier', async () => {
    await boot({ permissions: ['orders.view'], route: reportRoutes });
    expect(within(screen.getByRole('region', { name: t('nav.work') })).queryByRole('button', { name: new RegExp(`^${t('nav.reports')}`) })).toBeNull();
    cleanup();

    await boot({
      permissions: ['reports.view'],
      route: reportRoutes,
      view: { features: { freeToSell: false, reportsVisibleToOffice: false } },
    });
    await waitFor(() =>
      expect(
        within(screen.getByRole('region', { name: t('nav.work') })).queryByRole('button', { name: new RegExp(`^${t('nav.reports')}`) }),
      ).toBeNull(),
    );
  });

  it('is offered again when the switch is on, whatever else the snapshot says', async () => {
    await boot({
      permissions: ['reports.view'],
      route: reportRoutes,
      view: { features: { freeToSell: false, reportsVisibleToOffice: true } },
    });
    expect(
      within(screen.getByRole('region', { name: t('nav.work') })).getByRole('button', { name: new RegExp(`^${t('nav.reports')}`) }),
    ).toBeTruthy();
  });
});

describe('the refusal toast', () => {
  /** Sync now, from the footer's popover, as somebody holding one queued write. */
  async function syncAndReview({
    fromGallery = false,
    route,
  }: { fromGallery?: boolean; route?: Boot['route'] } = {}): Promise<void> {
    await boot({
      permissions: ['leads.view', 'leads.create'],
      view: { pendingCount: 1 },
      refusals: [{ mutationId: 'mut-9', entityId: 'L-TMP-9', error: 'Party is view-only for you' }],
      route,
    });
    if (fromGallery) {
      await act(async () => {
        fireEvent.click(screen.getByRole('link', { name: t('footer.designSystem') }));
        window.location.hash = '#/gallery';
        await wait(0);
      });
      expect(topbarTitle()).toBe(t('footer.designSystem'));
    }

    fireEvent.click(
      screen.getAllByRole('button', { name: new RegExp(t('sync.syncing', { count: 1 })) })[0]!,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('sync.flushNow') }));
      await wait(0);
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: t('action.reviewRefusals') }));
    });
  }

  it('takes somebody without sync.resolveConflicts to their refusals', async () => {
    await syncAndReview();

    expect(topbarTitle()).toBe(t('nav.conflicts'));
    expect(await screen.findByText('Party is view-only for you')).toBeTruthy();
  });

  it('keeps the page open while the last refusal is dismissed, and drops it after', async () => {
    await syncAndReview();

    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: t('sync.rejections.dismiss') }));
      await wait(0);
    });
    expect(topbarTitle()).toBe(t('nav.conflicts'));

    await act(async () => {
      fireEvent.click(screen.getByTitle(t('nav.dashboard')));
    });
    expect(screen.queryByTitle(t('nav.conflicts'))).toBeNull();
  });

  it('leaves the design-system gallery for the refusals, as it was pressed from there', async () => {
    // The footer is on every screen, so Sync now — and the toast it raises —
    // can be pressed with the gallery open.
    await syncAndReview({ fromGallery: true });

    expect(topbarTitle()).toBe(t('nav.conflicts'));
    expect(await screen.findByText('Party is view-only for you')).toBeTruthy();
    // And a reload does not put the gallery back.
    expect(window.location.hash).toBe('');
  });

  it('does not open for whoever signs in after the session ended on it', async () => {
    await syncAndReview({
      route: ({ method, url }) =>
        url === '/api/auth/sign-in' && method === 'POST'
          ? json({ session: panelSession(['leads.view']) })
          : undefined,
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: t('sync.rejections.dismiss') }));
      await wait(0);
    });
    expect(topbarTitle()).toBe(t('nav.conflicts'));

    // The Master stopped honouring the session — a password changed, say.
    await act(async () => {
      publishSessionEnded('signIn.notice.sessionEnded');
    });
    fireEvent.change(await screen.findByLabelText(t('signin.username')), {
      target: { value: 'ravi' },
    });
    fireEvent.change(screen.getByLabelText(t('signin.password')), { target: { value: 'secret' } });
    await act(async () => {
      fireEvent.submit(screen.getByLabelText(t('signin.password')).closest('form')!);
      await wait(0);
    });
    // An office-tier person starts on Basic Home, which needs no snapshot.
    expect(topbarTitle()).toBe(t('nav.basicHome'));
    // Nothing of the last person's view is drawn for this one: the data
    // screens wait for this session's own first snapshot.
    await act(async () => {
      fireEvent.click(screen.getByTitle(t('nav.dashboard')));
    });
    expect(screen.getByText(t('shell.waitingFirstSync'))).toBeTruthy();
    await sendSnapshot(snapshot());

    expect(topbarTitle()).toBe(t('nav.dashboard'));
    expect(screen.queryByTitle(t('nav.conflicts'))).toBeNull();
  });
});

describe('the New lead form', () => {
  it('starts blank again after a lead is saved', async () => {
    const calls = await boot({ permissions: ['leads.view', 'leads.create'] });

    fireEvent.click(newLeadButton());
    await draftOneProduct();
    fireEvent.click(screen.getAllByRole('button', { name: t('lead.add.draft.saveProduct') })[0]!);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('lead.add.save') }));
      await wait(0);
    });

    expect(
      calls.filter((call) => call.url === '/api/leads' && call.method === 'POST'),
    ).toHaveLength(1);
    expect(topbarTitle()).toBe(t('lead.board.tab.list'));

    await act(async () => {
      fireEvent.click(newLeadButton());
    });

    // Blank: the party is a search box again and nothing has been added.
    expect(screen.getByLabelText(t('lead.add.party.search'))).toBeTruthy();
    expect(screen.getByText(t('lead.add.panel.emptyNone'))).toBeTruthy();
    expect(screen.getByRole('button', { name: t('lead.add.save') })).toHaveProperty(
      'disabled',
      true,
    );
  });

  /** Saves one line through the form, the Master's answer to the POST being `answer`. */
  async function saveOneLead(answer?: Record<string, unknown>): Promise<void> {
    await boot({
      permissions: ['leads.view', 'leads.create'],
      route: ({ method, url }) =>
        answer && method === 'POST' && url === '/api/leads' ? json(answer) : undefined,
    });
    fireEvent.click(newLeadButton());
    await draftOneProduct();
    fireEvent.click(screen.getAllByRole('button', { name: t('lead.add.draft.saveProduct') })[0]!);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('lead.add.save') }));
      await wait(0);
    });
  }

  it('names the saved lead by its PO number when the Master numbered it in time', async () => {
    await saveOneLead({
      queued: true,
      id: 'L-TMP-1',
      mutationId: 'mut-1',
      pendingCount: 0,
      status: 'numbered',
      permanentId: 'LD0000000009',
      poNumber: 'PO/2026-27/00009',
    });
    expect(
      await screen.findByText(t('lead.add.savedOnline', { id: 'PO/2026-27/00009' })),
    ).toBeTruthy();
  });

  it('says the saved lead is Provisional when the Master is out of reach', async () => {
    // The default answer: queued, with no number (`status` absent or `provisional`).
    await saveOneLead();
    expect(await screen.findByText(t('lead.add.savedProvisional'))).toBeTruthy();
  });

  it('offers packaging beside the quantity, not required, while the company does not require it', async () => {
    await boot({
      permissions: ['leads.view', 'leads.create'],
      view: { features: { packagingRequiredOnConvert: false } },
    });

    fireEvent.click(newLeadButton());
    await draftOneProduct();

    const packaging = screen.getByLabelText(`${t('lead.add.draft.packaging')} — White`);
    expect(packaging.getAttribute('aria-required')).toBeNull();
    // Nothing picked and nothing required: the card adds as it is.
    expect(
      screen.getAllByRole('button', { name: t('lead.add.draft.saveProduct') })[0],
    ).toHaveProperty('disabled', false);
  });

  it('still marks packaging required when the company requires it', async () => {
    await boot({
      permissions: ['leads.view', 'leads.create'],
      view: { features: { packagingRequiredOnConvert: true } },
    });

    fireEvent.click(newLeadButton());
    await draftOneProduct();

    const packaging = screen.getByLabelText(`${t('lead.add.draft.packaging')} — White`);
    expect(packaging.getAttribute('aria-required')).toBe('true');
    // Counted but not packed: the card cannot be added yet.
    expect(
      screen.getAllByRole('button', { name: t('lead.add.draft.saveProduct') })[0],
    ).toHaveProperty('disabled', true);
  });

  it('asks before a reset throws a half-typed lead away, in the themed dialog', async () => {
    const nativeConfirm = vi.fn(() => true);
    vi.stubGlobal('confirm', nativeConfirm);
    await boot({ permissions: ['leads.view', 'leads.create'] });

    fireEvent.click(newLeadButton());
    fireEvent.change(await screen.findByLabelText(t('lead.add.details.notes')), {
      target: { value: 'Wants delivery before Diwali' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('screen.reset') }));
    });

    expect(nativeConfirm).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(t('lead.add.discardConfirm'))).toBeTruthy();

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: t('lead.add.discard') }));
      await wait(0);
    });

    expect((screen.getByLabelText(t('lead.add.details.notes')) as HTMLTextAreaElement).value).toBe(
      '',
    );
  });
});

describe('the order weight override', () => {
  /*
   * A write here is queued and answered at once, and no snapshot follows it —
   * an offline panel, or the round trip before the Master echoes the change.
   * The order on screen goes on saying 150 however many writes are queued,
   * which is the state the override has to be right in.
   */
  async function openOrder(route?: Boot['route']): Promise<Call[]> {
    const calls = await boot({
      permissions: ['orders.view'],
      view: { orders: [ORDER], pipelines: [ORDER_PIPELINE] },
      route,
    });
    await act(async () => {
      fireEvent.click(screen.getByTitle(t('nav.orders')));
    });
    await act(async () => {
      fireEvent.click(await screen.findByText(ORDER.id));
    });
    return calls;
  }

  const overrideWrites = (calls: Call[]) =>
    calls.filter((call) => call.method === 'PUT' && call.url === `/api/orders/${ORDER.id}`);

  it('is not sent when the field is left as it was', async () => {
    const calls = await openOrder();
    const field = await screen.findByLabelText(t('orders.detail.weightOverrideLabel'));

    await act(async () => {
      fireEvent.focus(field);
      fireEvent.blur(field);
      await wait(0);
    });

    expect(overrideWrites(calls)).toEqual([]);
  });

  it('is sent once when it was changed', async () => {
    const calls = await openOrder();
    const field = await screen.findByLabelText(t('orders.detail.weightOverrideLabel'));

    await act(async () => {
      fireEvent.change(field, { target: { value: '175' } });
      fireEvent.blur(field);
      await wait(0);
    });
    await act(async () => {
      fireEvent.blur(field);
      await wait(0);
    });

    expect(overrideWrites(calls).map((call) => call.body)).toEqual([
      { totalWeightKgOverride: 175 },
    ]);
  });

  it('is not sent, and says so, when the text is not a number', async () => {
    const calls = await openOrder();
    const field = await screen.findByLabelText(t('orders.detail.weightOverrideLabel'));

    await act(async () => {
      fireEvent.change(field, { target: { value: '1.2.3' } });
      fireEvent.blur(field);
      await wait(0);
    });

    // Sent, NaN would have crossed the wire as `null` and cleared the override.
    expect(overrideWrites(calls)).toEqual([]);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    // Said in words too: closing the order drops what was typed.
    expect(screen.getByText(t('orders.detail.weightOverrideInvalid'))).toBeTruthy();
  });

  it('is sent again when it is put back before the first write is answered', async () => {
    const calls = await openOrder();
    const field = await screen.findByLabelText(t('orders.detail.weightOverrideLabel'));

    await act(async () => {
      fireEvent.change(field, { target: { value: '175' } });
      fireEvent.blur(field);
      await wait(0);
    });
    await act(async () => {
      fireEvent.change(field, { target: { value: '150' } });
      fireEvent.blur(field);
      await wait(0);
    });

    // Dropping the second left 175 queued under a field that says 150.
    expect(overrideWrites(calls).map((call) => call.body)).toEqual([
      { totalWeightKgOverride: 175 },
      { totalWeightKgOverride: 150 },
    ]);
  });

  it('sends an edit typed while the save before it was still on its way', async () => {
    let answer: (response: Response) => void = () => undefined;
    const calls = await openOrder(({ method, url }) =>
      method === 'PUT' && url === `/api/orders/${ORDER.id}`
        ? new Promise<Response>((resolve) => {
            answer = resolve;
          })
        : undefined,
    );
    const field = await screen.findByLabelText(t('orders.detail.weightOverrideLabel'));

    await act(async () => {
      fireEvent.change(field, { target: { value: '175' } });
      fireEvent.blur(field);
      fireEvent.focus(field);
      fireEvent.change(field, { target: { value: '180' } });
      await wait(0);
    });
    await act(async () => {
      answer(json({ queued: true, id: ORDER.id, mutationId: 'mut-2', pendingCount: 1 }));
      await wait(0);
    });
    await act(async () => {
      fireEvent.blur(field);
      await wait(0);
    });

    expect(overrideWrites(calls).map((call) => call.body)).toEqual([
      { totalWeightKgOverride: 175 },
      { totalWeightKgOverride: 180 },
    ]);
  });

  it('is put back even while the save it undoes is still on its way', async () => {
    const calls = await openOrder(({ method, url }) =>
      method === 'PUT' && url === `/api/orders/${ORDER.id}`
        ? new Promise<Response>(() => undefined)
        : undefined,
    );
    const field = await screen.findByLabelText(t('orders.detail.weightOverrideLabel'));

    await act(async () => {
      fireEvent.change(field, { target: { value: '175' } });
      fireEvent.blur(field);
      await wait(0);
    });
    await act(async () => {
      fireEvent.focus(field);
      fireEvent.change(field, { target: { value: '150' } });
      fireEvent.blur(field);
      await wait(0);
    });

    expect(overrideWrites(calls).map((call) => call.body)).toEqual([
      { totalWeightKgOverride: 175 },
      { totalWeightKgOverride: 150 },
    ]);
  });

  it('is tried again on the next blur after a save that failed', async () => {
    let failed = false;
    const calls = await openOrder(({ method, url }) => {
      if (method !== 'PUT' || url !== `/api/orders/${ORDER.id}` || failed) return undefined;
      failed = true;
      return json({ error: 'queue_failed', message: 'Could not queue that' }, 500);
    });
    const field = await screen.findByLabelText(t('orders.detail.weightOverrideLabel'));

    await act(async () => {
      fireEvent.change(field, { target: { value: '175' } });
      fireEvent.blur(field);
      await wait(0);
    });
    await act(async () => {
      fireEvent.focus(field);
      fireEvent.blur(field);
      await wait(0);
    });

    expect(overrideWrites(calls).map((call) => call.body)).toEqual([
      { totalWeightKgOverride: 175 },
      { totalWeightKgOverride: 175 },
    ]);
  });

  it('is cleared when the field is emptied', async () => {
    const calls = await openOrder();
    const field = await screen.findByLabelText(t('orders.detail.weightOverrideLabel'));

    await act(async () => {
      fireEvent.change(field, { target: { value: '' } });
      fireEvent.blur(field);
      await wait(0);
    });

    expect(overrideWrites(calls).map((call) => call.body)).toEqual([
      { totalWeightKgOverride: null },
    ]);
  });
});

describe('Edit lead', () => {
  const LEAD_PIPELINE = {
    id: 'pipe-leads',
    kind: 'lead',
    name: 'Leads',
    stages: [{ id: 'stage-lead', name: 'New', sequence: 1, isDefault: true, isTerminal: false }],
  };

  const LEAD = {
    id: 'LD-1',
    partyId: PARTY.id,
    partyName: PARTY.name,
    ownerId: 'user-1',
    stageId: 'stage-lead',
    stageName: 'New',
    sourcePlatform: null,
    followUpDate: '2026-10-02',
    partyWiseMode: false,
    notes: 'Call before noon',
    customFields: {},
    incomplete: false,
    missingFields: [],
    convertedOrderId: null,
    items: [
      {
        id: 'li-1',
        productId: PRODUCT.id,
        variantId: 'var-1',
        productName: PRODUCT.name,
        categoryName: CATEGORY.name,
        categoryCode: null,
        brandName: null,
        alias: null,
        code: 'AQ-W',
        variantLabel: 'White',
        colour: null,
        size: null,
        weightKg: 30,
        packaging: null,
        grade: null,
        sequence: 1,
        fromPartyVariant: false,
        notes: null,
        quantity: 5,
        lineWeightKg: 150,
      },
    ],
    timeline: [],
    totalWeightKg: 150,
    linesWithoutWeight: 0,
    createdAt: '2026-09-24T00:00:00.000Z',
    sync: { hlc: 'h1', fieldHlc: { notes: 'h1', items: 'h1' } },
  };

  it('opens the saved lead in the entry form and sends what changed back on save', async () => {
    const calls = await boot({
      permissions: ['leads.view', 'leads.edit'],
      view: { leads: [LEAD], pipelines: [LEAD_PIPELINE] },
      route: ({ method, url }) =>
        method === 'PUT' && url === `/api/leads/${LEAD.id}`
          ? json({ queued: true, id: LEAD.id, mutationId: 'mut-3', pendingCount: 1 })
          : undefined,
    });
    await act(async () => {
      fireEvent.click(screen.getByTitle(t('nav.leads')));
    });
    await act(async () => {
      fireEvent.click((await screen.findAllByText(PARTY.name))[0]!);
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: t('lead.edit.action') }));
    });

    expect(
      await screen.findByRole('heading', { name: t('lead.edit.title') }, { timeout: 10_000 }),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText(t('lead.add.details.notes')), {
      target: { value: 'Call after lunch' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('lead.add.save') }));
      await wait(0);
    });

    const writes = calls.filter(
      (call) => call.method === 'PUT' && call.url === `/api/leads/${LEAD.id}`,
    );
    expect(writes).toHaveLength(1);
    const body = writes[0]!.body as Record<string, unknown>;
    // Only the changed field, with the clock it was opened at: the Master's
    // merge then cannot take the untouched lines or party as an edit.
    expect(body).toMatchObject({ notes: 'Call after lunch', baseFieldHlc: { notes: 'h1' } });
    expect(body).not.toHaveProperty('items');
    expect(body).not.toHaveProperty('partyId');
    // Back on the lead, not left on the form.
    expect(screen.queryByRole('heading', { name: t('lead.edit.title') })).toBeNull();
    expect(calls.some((call) => call.url === '/api/leads' && call.method === 'POST')).toBe(false);
  });

  describe('the Filling and Dispatch notes on a pending order', () => {
    async function openLead(permissions: string[]): Promise<Call[]> {
      const calls = await boot({ permissions, view: { leads: [LEAD], pipelines: [LEAD_PIPELINE] } });
      await act(async () => {
        fireEvent.click(screen.getByTitle(t('nav.leads')));
      });
      await act(async () => {
        fireEvent.click((await screen.findAllByText(PARTY.name))[0]!);
      });
      await screen.findByText(t('lead.detail.lineItems'));
      return calls;
    }

    afterEach(() => {
      delete (window as Window & { orderbook?: unknown }).orderbook;
    });

    it('is absent without leads.export and offered with it', async () => {
      await openLead(['leads.view']);
      expect(screen.queryByRole('button', { name: t('orderNote.filling') })).toBeNull();
      expect(screen.queryByRole('button', { name: t('orderNote.dispatch') })).toBeNull();

      cleanup();
      await openLead(['leads.view', 'leads.export']);
      expect(screen.getByRole('button', { name: t('orderNote.filling') })).toBeTruthy();
      expect(screen.getByRole('button', { name: t('orderNote.dispatch') })).toBeTruthy();
    });

    it('opens the note from the local snapshot, headed "Pending Order No.", and back returns to the lead', async () => {
      await openLead(['leads.view', 'leads.export']);
      fireEvent.click(screen.getByRole('button', { name: t('orderNote.filling') }));

      expect((await screen.findAllByText(t('orderNote.pendingOrderNo'))).length).toBeGreaterThan(0);
      expect(screen.queryByText(t('orderNote.orderId'))).toBeNull();
      expect(screen.getAllByText(LEAD.id).length).toBeGreaterThan(0);

      fireEvent.click(screen.getByRole('button', { name: t('action.backToList') }));
      expect(await screen.findByText(t('lead.detail.lineItems'))).toBeTruthy();
    });

    it('prints the copies asked for, and sends no write for the vehicle number', async () => {
      const printPage = vi.fn().mockResolvedValue({ ok: true });
      (window as Window & { orderbook?: unknown }).orderbook = { shellVersion: 'test', applyUpdate: vi.fn(), printPage };
      const calls = await openLead(['leads.view', 'leads.export']);
      fireEvent.click(screen.getByRole('button', { name: t('orderNote.dispatch') }));

      const field = await screen.findByLabelText(t('orderNote.vehicleNo'));
      expect((field as HTMLInputElement).disabled).toBe(false);
      await act(async () => {
        fireEvent.change(field, { target: { value: 'gj 03 ab 4471' } });
        fireEvent.blur(field);
        await wait(0);
      });

      fireEvent.change(screen.getByLabelText(t('orderNote.copies')), { target: { value: '4' } });
      fireEvent.click(screen.getByRole('button', { name: t('orderNote.print') }));
      await waitFor(() => expect(printPage).toHaveBeenLastCalledWith({ deviceName: undefined, copies: 4 }));
      expect(calls.filter((call) => call.method !== 'GET' && call.url.startsWith('/api/leads'))).toEqual([]);
    });
  });

  it('shows who else has the lead open, from the presence frame, and leaves the reader out', async () => {
    await boot({
      permissions: ['leads.view'],
      view: { leads: [LEAD], pipelines: [LEAD_PIPELINE] },
      route: ({ url }) => (url === '/api/presence' ? json(null) : undefined),
    });
    await act(async () => {
      fireEvent.click(screen.getByTitle(t('nav.leads')));
    });
    await act(async () => {
      fireEvent.click((await screen.findAllByText(PARTY.name))[0]!);
    });
    await screen.findByText(t('lead.detail.lineItems'));

    const person = (userId: string, displayName: string, editing: boolean) => ({
      userId,
      displayName,
      avatar: null,
      tier: 'office',
      editing,
      since: '2026-10-03T09:00:00.000Z',
    });
    await act(async () => {
      FakeEventSource.instances.at(-1)!.emit('presence', {
        recordKind: 'lead',
        recordId: LEAD.id,
        entries: [person('user-1', 'Asha', false), person('user-2', 'Ravi Kumar', true)],
        forUserId: 'user-1',
      });
    });

    expect(await screen.findByTitle(t('presence.editing', { name: 'Ravi Kumar' }))).toBeTruthy();
    expect(screen.queryByTitle(t('presence.viewing', { name: 'Asha' }))).toBeNull();
  });

  it('keeps a provisional lead open when the Master numbers it, and names the number', async () => {
    const temporaryId = formatTemporaryId(deviceCodeFromSeed('counter'), 3);
    const provisional = { ...LEAD, id: temporaryId, sync: { hlc: '', fieldHlc: {} } };
    await boot({
      permissions: ['leads.view'],
      view: { leads: [provisional], pipelines: [LEAD_PIPELINE] },
    });
    await act(async () => {
      fireEvent.click(screen.getByTitle(t('nav.leads')));
    });
    await act(async () => {
      fireEvent.click((await screen.findAllByText(PARTY.name))[0]!);
    });
    await screen.findByText(t('lead.detail.lineItems'));
    // Not numbered yet: Provisional, with the temporary id beside it.
    expect(screen.getAllByText(t('lead.number.provisional')).length).toBeGreaterThan(0);

    await act(async () => {
      FakeEventSource.instances.at(-1)!.emit('numbered', {
        entity: 'lead',
        temporaryId,
        permanentId: 'LD0000000012',
        poNumber: 'PO/2026-27/00012',
        announced: false,
      });
    });
    expect(await screen.findByText(t('lead.numbered.toast', { number: 'PO/2026-27/00012' }))).toBeTruthy();

    // The permanent record replaces the provisional one: still open, now by its number.
    await sendSnapshot(
      snapshot({
        leads: [{ ...LEAD, id: 'LD0000000012', poNumber: 'PO/2026-27/00012' }],
        pipelines: [LEAD_PIPELINE],
      }),
    );
    expect(screen.getByText(t('lead.detail.lineItems'))).toBeTruthy();
    expect(screen.getAllByText('PO/2026-27/00012').length).toBeGreaterThan(0);
    expect(screen.queryByText(t('lead.number.provisional'))).toBeNull();
  });

  it('is not offered without leads.edit', async () => {
    await boot({
      permissions: ['leads.view'],
      view: { leads: [LEAD], pipelines: [LEAD_PIPELINE] },
    });
    await act(async () => {
      fireEvent.click(screen.getByTitle(t('nav.leads')));
    });
    await act(async () => {
      fireEvent.click((await screen.findAllByText(PARTY.name))[0]!);
    });

    await screen.findByText(t('lead.detail.lineItems'));
    expect(screen.queryByRole('button', { name: t('lead.edit.action') })).toBeNull();
  });
});

describe('the Filling and Dispatch notes on an order', () => {
  const LINE = {
    id: 'line-1', variantId: 'var-1', productId: 'prod-1', productName: 'Rustic Wood',
    categoryName: 'Duragres', size: '600x600', brandName: null, variantLabel: 'Ivory',
    colour: null, grade: 'Std', packaging: 'Box', quantity: 12, weightKg: 2, lineWeightKg: 24,
  };
  const NOTE_ORDER = { ...ORDER, items: [LINE] };

  async function openOrder(permissions: string[]): Promise<Call[]> {
    const calls = await boot({
      permissions,
      view: { orders: [NOTE_ORDER], pipelines: [ORDER_PIPELINE] },
    });
    await act(async () => {
      fireEvent.click(screen.getByTitle(t('nav.orders')));
    });
    await act(async () => {
      fireEvent.click(await screen.findByText(ORDER.id));
    });
    return calls;
  }

  const pageLabel = t('orderNote.page', { n: 1, total: 1 });

  afterEach(() => {
    delete (window as Window & { orderbook?: unknown }).orderbook;
  });

  it('is not offered without orders.export', async () => {
    await openOrder(['orders.view']);
    await screen.findByText(t('orders.detail.products'));
    expect(screen.queryByRole('button', { name: t('orderNote.filling') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('orderNote.dispatch') })).toBeNull();
  });

  it('opens a preview with the order on it, and back returns to the order', async () => {
    await openOrder(['orders.view', 'orders.export']);
    fireEvent.click(await screen.findByRole('button', { name: t('orderNote.filling') }));

    // Twice: the preview, and the copy that print shows.
    expect((await screen.findAllByText(pageLabel)).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Duragres').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: t('action.backToList') }));
    expect(await screen.findByText(t('orders.detail.products'))).toBeTruthy();
  });

  it('prints through the shell to the printer picked, and asks each time until one is', async () => {
    const printPage = vi.fn().mockResolvedValue({ ok: true });
    (window as Window & { orderbook?: unknown }).orderbook = {
      shellVersion: 'test',
      applyUpdate: vi.fn(),
      listPrinters: vi
        .fn()
        .mockResolvedValue([{ name: 'HP Laser', displayName: 'HP Laser', isDefault: true }]),
      printPage,
    };
    await openOrder(['orders.view', 'orders.export']);
    fireEvent.click(await screen.findByRole('button', { name: t('orderNote.filling') }));

    const printer = await screen.findByLabelText(t('orderNote.printer'));
    await screen.findByRole('option', { name: 'HP Laser' });

    fireEvent.click(screen.getByRole('button', { name: t('orderNote.print') }));
    // `copies` is always sent now (deliberate): one unless the person set more.
    await waitFor(() => expect(printPage).toHaveBeenLastCalledWith({ deviceName: undefined, copies: 1 }));

    fireEvent.change(printer, { target: { value: 'HP Laser' } });
    fireEvent.click(screen.getByRole('button', { name: t('orderNote.print') }));
    await waitFor(() => expect(printPage).toHaveBeenLastCalledWith({ deviceName: 'HP Laser', copies: 1 }));
  });

  it('falls back to the browser print when there is no shell', async () => {
    const print = vi.fn();
    vi.stubGlobal('print', print);
    await openOrder(['orders.view', 'orders.export']);
    fireEvent.click(await screen.findByRole('button', { name: t('orderNote.dispatch') }));

    fireEvent.click(await screen.findByRole('button', { name: t('orderNote.print') }));
    expect(print).toHaveBeenCalledTimes(1);
  });

  it('saves the vehicle number, tidied, when the field is left', async () => {
    const calls = await openOrder(['orders.view', 'orders.export', 'orders.edit']);
    fireEvent.click(await screen.findByRole('button', { name: t('orderNote.dispatch') }));

    const field = await screen.findByLabelText(t('orderNote.vehicleNo'));
    await act(async () => {
      fireEvent.change(field, { target: { value: 'gj 03  ab 4471' } });
      fireEvent.blur(field);
      await wait(0);
    });

    const writes = calls.filter((call) => call.method === 'PUT' && call.url === `/api/orders/${ORDER.id}`);
    expect(writes.map((call) => call.body)).toEqual([{ vehicleNumber: 'GJ 03 AB 4471' }]);
  });

  it('leaves the vehicle number read-only without orders.edit', async () => {
    await openOrder(['orders.view', 'orders.export']);
    fireEvent.click(await screen.findByRole('button', { name: t('orderNote.dispatch') }));
    const field = await screen.findByLabelText(t('orderNote.vehicleNo'));
    expect((field as HTMLInputElement).disabled).toBe(true);
  });
});

describe('searching the final orders list', () => {
  it('narrows the rows to the words typed, across party, id and lines', async () => {
    const other = { ...ORDER, id: 'ORD-2', partyName: 'Blue Sky Traders' };
    await boot({
      permissions: ['orders.view'],
      view: { orders: [ORDER, other], pipelines: [ORDER_PIPELINE] },
    });
    await act(async () => {
      fireEvent.click(screen.getByTitle(t('nav.orders')));
    });
    await screen.findByText('ORD-2');

    const box = await screen.findByLabelText(t('orders.search.label'));
    await act(async () => {
      fireEvent.change(box, { target: { value: 'blue sky' } });
    });

    expect(screen.queryByText('ORD-1')).toBeNull();
    expect(screen.getByText('ORD-2')).toBeTruthy();
  });
});

describe('the activity log (1.3)', () => {
  it('is offered with logs.view and opens the shared Logs screen, read from the Master', async () => {
    const calls = await boot({
      permissions: ['logs.view'],
      route: ({ url }) => {
        const path = url.split('?')[0];
        if (path === '/api/logs') {
          return json({ items: [], nextCursor: null, prevCursor: null, limit: 50 });
        }
        if (path === '/api/logs/facets') return json({ actors: [], entityTypes: [], actions: [] });
        return undefined;
      },
    });

    await act(async () => {
      fireEvent.click(screen.getByTitle(t('nav.logs')));
      await wait(0);
    });

    await waitFor(() =>
      expect(calls.some((call) => call.url.split('?')[0] === '/api/logs')).toBe(true),
    );
    await waitFor(() => expect(document.querySelector('[data-screen-search]')).not.toBeNull());
  });

  it('is not offered without logs.view', async () => {
    await boot({ permissions: ['orders.view'] });

    expect(screen.queryByTitle(t('nav.logs'))).toBeNull();
  });
});

describe('the Chatroom (1.3 Phase 6)', () => {
  const ROOM = {
    id: 'room-1', kind: 'group', name: 'Dispatch desk', description: null, announceOnly: false,
    archivedAt: null, myRole: 'member', muted: false, lastSeq: 4, lastReadSeq: 1, unread: 3,
    mentionUnread: 0, memberCount: 2, lastMessageAt: '2026-10-03T09:00:00.000Z', lastMessage: null,
    direct: null,
  };

  const chatRoutes = (call: Call): Response | undefined => {
    const path = call.url.split('?')[0];
    if (path === '/api/chat/rooms') return json([ROOM]);
    if (path === '/api/chat/rooms/room-1') return json({ ...ROOM, members: [], pinned: [] });
    if (path === '/api/chat/rooms/room-1/messages') return json([]);
    if (path === '/api/chat/tasks') return json([]);
    return undefined;
  };

  const bootChat = (permissions: string[], extra?: Boot['route'], view: Record<string, unknown> = {}) =>
    boot({
      permissions,
      view,
      route: (call) => extra?.(call) ?? chatRoutes(call),
    });

  const row = () => screen.queryByTitle(t('nav.chatroom'));
  const gets = (calls: Call[], path: string) =>
    calls.filter((call) => call.method === 'GET' && call.url.split('?')[0] === path).length;

  it('is a Work row only with chat.use, carrying the unread total', async () => {
    await bootChat(['chat.use']);
    await waitFor(() => expect(row()?.textContent).toContain('3'));
    cleanup();

    await boot({ permissions: ['leads.view'] });
    expect(row()).toBeNull();
  });

  it('opens on Alt+C and lists the rooms, with no snapshot needed', async () => {
    await bootChat(['chat.use']);
    await waitFor(() => expect(row()).not.toBeNull());

    await waitFor(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', altKey: true, bubbles: true, cancelable: true }),
      );
      expect(topbarTitle()).toBe(t('chat.sub.rooms'));
    });
    expect(await screen.findByText('Dispatch desk')).toBeTruthy();
  });

  it('reads the rooms again when a chat frame arrives and when the stream comes back, without opening a second stream', async () => {
    const calls = await bootChat(['chat.use']);
    await waitFor(() => expect(gets(calls, '/api/chat/rooms')).toBeGreaterThan(0));
    const before = gets(calls, '/api/chat/rooms');

    await act(async () => {
      FakeEventSource.instances.at(-1)!.emit('chat', { kind: 'room', roomId: 'room-1', forUserId: 'user-1' });
      await wait(700);
    });
    expect(gets(calls, '/api/chat/rooms')).toBeGreaterThan(before);

    const afterPush = gets(calls, '/api/chat/rooms');
    await act(async () => {
      FakeEventSource.instances.at(-1)!.emit('error', {});
      FakeEventSource.instances.at(-1)!.emit('open', {});
      await wait(700);
    });
    expect(gets(calls, '/api/chat/rooms')).toBeGreaterThan(afterPush);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('offers Groups only with chat.createGroups or chat.manage', async () => {
    await bootChat(['chat.use']);
    await act(async () => {
      fireEvent.click(await screen.findByTitle(t('nav.chatroom')));
      await wait(0);
    });
    expect(await screen.findByTitle(t('chat.sub.tasks'))).toBeTruthy();
    expect(screen.queryByTitle(t('chat.sub.groups'))).toBeNull();
    cleanup();

    await bootChat(['chat.use', 'chat.createGroups']);
    await act(async () => {
      fireEvent.click(await screen.findByTitle(t('nav.chatroom')));
      await wait(0);
    });
    expect(await screen.findByTitle(t('chat.sub.groups'))).toBeTruthy();
  });

  it('shares a final order from its detail, only with chat.use and chat.shareRecords', async () => {
    const orders = { orders: [ORDER], pipelines: [ORDER_PIPELINE] };
    const openOrder = async (permissions: string[]) => {
      await bootChat(permissions, undefined, orders);
      await act(async () => {
        fireEvent.click(screen.getByTitle(t('nav.orders')));
        await wait(0);
      });
      fireEvent.click(await screen.findByText(ORDER.id));
      await screen.findByRole('button', { name: t('action.backToList') });
    };

    await openOrder(['orders.view', 'chat.use']);
    expect(screen.queryByRole('button', { name: t('chat.share.button') })).toBeNull();
    cleanup();

    await openOrder(['orders.view', 'chat.use', 'chat.shareRecords']);
    fireEvent.click(screen.getByRole('button', { name: t('chat.share.button') }));
    expect((await screen.findAllByRole('heading', { name: t('chat.share.title') })).length).toBeGreaterThan(0);
    expect(await screen.findByText('Dispatch desk')).toBeTruthy();
  });

  describe('a record chip', () => {
    const chipMessage = (id: string) => ({
      id: 'CM1', roomId: 'room-1', seq: 1, kind: 'text', author: { id: 'user-2', displayName: 'Bina', avatar: null, tier: 'office' },
      body: 'please look', refs: [{ kind: 'order', id, label: id, partyName: 'Sharma Traders', restricted: false }],
      mentions: [], system: null, createdAt: new Date().toISOString(), editedAt: null, deletedAt: null,
      pinnedAt: null, pinnedBy: null, task: null, clientId: null,
    });

    async function openChip(orderId: string, answer: Response): Promise<Call[]> {
      const calls = await bootChat(
        ['orders.view', 'chat.use'],
        (call) => {
          const path = call.url.split('?')[0];
          if (path === '/api/chat/rooms/room-1/messages') return json([chipMessage(orderId)]);
          if (call.url === `/api/orders/${orderId}`) return answer;
          return undefined;
        },
        { orders: [ORDER], pipelines: [ORDER_PIPELINE] },
      );
      await act(async () => {
        fireEvent.click(screen.getByTitle(t('nav.chatroom')));
        await wait(0);
      });
      fireEvent.click((await screen.findByText('Dispatch desk')).closest('button')!);
      fireEvent.click((await screen.findByText(new RegExp(`${orderId} . Sharma Traders`))).closest('button')!);
      return calls;
    }

    it("opens an order this panel's view does not hold by fetching it from the Master", async () => {
      const calls = await openChip('ORD-9', json({ ...ORDER, id: 'ORD-9', partyName: 'Patel Tiles' }));

      expect(await screen.findByText(/Patel Tiles/, {}, { timeout: 5000 })).toBeTruthy();
      expect(calls.some((call) => call.url === '/api/orders/ORD-9')).toBe(true);
      expect(await screen.findByRole('button', { name: t('action.backToList') })).toBeTruthy();
    });

    it('says the record is not available, and leaves the list, when the Master will not give it', async () => {
      await openChip('ORD-404', json({ error: 'not_found', message: 'Order not found' }, 404));

      expect(await screen.findByText(t('nav.recordNotAvailable'))).toBeTruthy();
      expect(screen.queryByRole('button', { name: t('action.backToList') })).toBeNull();
    });
  });
});
