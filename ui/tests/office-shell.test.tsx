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
      return json({ session: panelSession(permissions) });
    }
    if (path === '/api/sync') return json({ ...CONNECTION, pendingCount: 0, rejections: held });
    // Answered for every test: `api.ts` shares one in-flight GET per path across
    // the file, so a bell read left hanging by one test would swallow the next's.
    if (path === '/api/notifications') return json({ items: [], unreadCount: 0 });
    // The faces on a board's cards (R22), nobody by default, for the same reason.
    if (path === '/api/presence/board') {
      return json({ recordKind: url.includes('kind=order') ? 'order' : 'lead', records: {} });
    }
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
  await waitFor(() => expect(document.querySelector('.ob-footer')).not.toBeNull());
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

/** The panel's own lead form, as far as a sub product's card with one quantity typed. */
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
  // The same box is then the product's sub-product bar: the sub product opens its card.
  fireEvent.mouseDown(await screen.findByRole('button', { name: new RegExp(PRODUCT.name) }));

  const qty = await screen.findByLabelText(`${t('lead.add.draft.col.quantity')} — AQ-W`);
  expect(document.activeElement).toBe(qty);
  fireEvent.change(qty, { target: { value: '5' } });
}

/** The card's Add sub product button. */
const addSubProduct = (): HTMLElement =>
  screen.getAllByRole('button', { name: t('lead.add.draft.saveProduct') })[0]!;


/** A new order's notes sit in its Print & PDF menu (2026-10-08). */
async function noteItem(kind: 'orderNote.filling' | 'orderNote.dispatch'): Promise<HTMLElement> {
  if (!screen.queryByRole('menu')) {
    fireEvent.click(await screen.findByRole('button', { name: t('lead.detail.printMenu') }));
  }
  return screen.getByRole('menuitem', { name: t(kind) });
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
    expect(since.nextElementSibling?.textContent).toContain(`(${formatElapsed(5 * MINUTE)})`);
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
    expect(
      screen.getByRole('button', { name: t('notification.unreadLabel', { count: 1 }) }),
    ).toBeTruthy();
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
    expect(
      screen.queryByText(t('office.link.clockSkew', { duration: formatElapsed(90_000) })),
    ).toBeNull();

    await status({ clockSkewMs: -5 * MINUTE });
    expect(
      screen.getByText(t('office.link.clockSkew', { duration: formatElapsed(5 * MINUTE) })),
    ).toBeTruthy();

    await status({ state: 'disconnected', notRecognised: true });
    expect(screen.getByText(t('office.link.notRecognised', { host: '10.0.0.1' }))).toBeTruthy();
  });

  it('re-reads the session on a session frame, so a role edit reaches a window that stays connected (1.4 R9)', async () => {
    const calls = await boot({ permissions: ['leads.view'] });
    const reads = () => calls.filter((call) => call.url.split('?')[0] === '/api/session').length;
    await waitFor(() => expect(reads()).toBeGreaterThan(0));

    const before = reads();
    await act(async () => {
      FakeEventSource.instances.at(-1)!.emit('session', null);
      await wait(0);
    });

    expect(reads()).toBeGreaterThan(before);
  });

  it('re-reads the bell on a pushed notice and when the stream reopens, on the same stream', async () => {
    const notify = desktopShell();
    const calls = await boot({ permissions: ['leads.view'] });
    const reads = () =>
      calls.filter((call) => call.url.split('?')[0] === '/api/notifications').length;
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

describe('the Dashboard orders tile (stock removed, 1.4)', () => {
  async function ordersTile(orders: unknown[]): Promise<HTMLElement> {
    await boot({
      permissions: ['leads.view', 'orders.view'],
      view: { orders, permissions: ['leads.view', 'orders.view'] },
    });
    await pressAltDigitUntil(2, t('nav.dashboard'));
    return screen.getByText(t('dashboard.orders.title')).closest('.ob-stattile') as HTMLElement;
  }

  it('counts the pieces on open orders as pcs still to dispatch', async () => {
    const tile = await ordersTile([
      { ...ORDER, items: [{ quantity: 3 }, { quantity: 4 }] },
      {
        ...ORDER,
        id: 'ORD-2',
        items: [{ quantity: 99 }],
        dispatchedAt: '2026-09-23T00:00:00.000Z',
      },
    ]);

    expect(within(tile).getByText('7 pcs still to dispatch')).toBeTruthy();
  });

  it('says nothing is waiting when no order is open', async () => {
    const tile = await ordersTile([
      { ...ORDER, items: [{ quantity: 5 }], dispatchedAt: '2026-09-23T00:00:00.000Z' },
    ]);

    expect(within(tile).getByText(t('dashboard.orders.noneOpen'))).toBeTruthy();
  });
});

describe('where a person lands', () => {
  it('starts an office-tier person on Basic Home, before any snapshot', async () => {
    routeFetch(({ url }) => {
      const path = url.split('?')[0] ?? url;
      if (path === '/api/connection') return json(CONNECTION);
      if (path === '/api/session') {
        return json({ session: panelSession(['leads.view']) });
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
    await waitFor(() => expect(document.querySelector('.ob-footer')).not.toBeNull());

    // No snapshot has been sent: Basic Home reads only the sidebar.
    expect(topbarTitle()).toBe(t('nav.basicHome'));
    const work = within(screen.getByRole('region', { name: t('nav.work') }));
    expect(work.getByRole('button', { name: new RegExp(`^${t('nav.leads')}`) })).toBeTruthy();
  });

  it('1.4 R9: offers Chatroom and Printroom tiles to an office-tier person holding chat.use and print.send', async () => {
    const permissions = ['leads.view', 'chat.use', 'print.send'];
    routeFetch(({ url }) => {
      const path = url.split('?')[0] ?? url;
      if (path === '/api/connection') return json(CONNECTION);
      if (path === '/api/session') return json({ session: panelSession(permissions) });
      if (path === '/api/sync') return json({ ...CONNECTION, pendingCount: 0, rejections: [] });
      if (path === '/api/chat/rooms' || path === '/api/chat/tasks') return json([]);
      if (path === '/api/print-jobs') return json({ jobs: [], nextCursor: null, waitingCount: 0 });
      if (path === '/api/print-stations') return json([]);
      return undefined;
    });
    const App = await loadApp('office');
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    await waitFor(() => expect(document.querySelector('.ob-footer')).not.toBeNull());

    const tiles = [...document.querySelectorAll('.ob-launcher .ob-tile-label')].map(
      (tile) => tile.textContent,
    );
    expect(tiles).toContain(t('nav.chatroom'));
    expect(tiles).toContain(t('nav.printroom'));
  });

  it('starts an admin-tier person on the Dashboard', async () => {
    await boot({
      permissions: ['leads.view'],
      route: ({ url }) =>
        url.split('?')[0] === '/api/session'
          ? json({
              session: { ...panelSession(['leads.view']), roleTier: 'admin' },
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
      if (path === '/api/session') return json({ session: null });
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
  it('stays open after the hash changes to #/gallery', async () => {
    await boot({ permissions: ['leads.view'] });

    // The hash changes, then `hashchange` fires.
    await act(async () => {
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
    range: {
      period: 'last6Months',
      fromDate: '2026-05-01',
      toDateExclusive: '2026-11-01',
      months: ['2026-05', '2026-10'],
      timeZone: 'Asia/Kolkata',
    },
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
    expect(document.querySelector('.ob-topbar')?.textContent).toContain(
      t('reports.kind.dispatches'),
    );
  });

  it('asks again after every change the Master sends, even one that leaves the record counts as they were', async () => {
    const calls = await boot({ permissions: ['reports.view'], route: reportRoutes });
    const work = within(screen.getByRole('region', { name: t('nav.work') }));
    await act(async () => {
      fireEvent.click(work.getByRole('button', { name: new RegExp(`^${t('nav.reports')}`) }));
    });
    await screen.findByText('2026-10');

    const tableCalls = (): number =>
      calls.filter((call) => call.url.startsWith('/api/reports/table/')).length;
    const change = {
      entity: 'party',
      action: 'updated',
      id: 'PT0000000001',
      payload: { id: 'PT0000000001', name: 'Shah', city: 'Morbi' },
    };

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
        call.url.split('?')[0] === '/api/reports/options'
          ? json({ ...OPTIONS, canExport: true })
          : reportRoutes(call),
    });
    expect(calls.length).toBeGreaterThan(0);
    const work = within(screen.getByRole('region', { name: t('nav.work') }));
    await act(async () => {
      fireEvent.click(work.getByRole('button', { name: new RegExp(`^${t('nav.reports')}`) }));
    });
    await screen.findByText('2026-10');
    expect(screen.getByRole('link', { name: t('reports.previewPdf') })).toBeTruthy();

    await act(async () => {
      FakeEventSource.instances
        .at(-1)!
        .emit('status', { state: 'disconnected', disconnectedSince: new Date().toISOString() });
      await wait(0);
    });
    expect(screen.queryByRole('link', { name: t('reports.previewPdf') })).toBeNull();

    await act(async () => {
      FakeEventSource.instances
        .at(-1)!
        .emit('status', { state: 'connected', disconnectedSince: null });
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

    const tableCalls = (): number =>
      calls.filter((call) => call.url.startsWith('/api/reports/table/')).length;
    const before = tableCalls();
    await act(async () => {
      FakeEventSource.instances
        .at(-1)!
        .emit('change', {
          entity: 'option_list',
          action: 'updated',
          id: 'OL0000000001',
          payload: {},
        });
    });
    // Let any wrongly scheduled fetch land before counting.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(tableCalls()).toBe(before);
  });

  it('is not offered without reports.view, nor when the company has switched it off for the Office tier', async () => {
    await boot({ permissions: ['orders.view'], route: reportRoutes });
    expect(
      within(screen.getByRole('region', { name: t('nav.work') })).queryByRole('button', {
        name: new RegExp(`^${t('nav.reports')}`),
      }),
    ).toBeNull();
    cleanup();

    await boot({
      permissions: ['reports.view'],
      route: reportRoutes,
      view: { features: { reportsVisibleToOffice: false } },
    });
    await waitFor(() =>
      expect(
        within(screen.getByRole('region', { name: t('nav.work') })).queryByRole('button', {
          name: new RegExp(`^${t('nav.reports')}`),
        }),
      ).toBeNull(),
    );
  });

  it('is offered again when the switch is on, whatever else the snapshot says', async () => {
    await boot({
      permissions: ['reports.view'],
      route: reportRoutes,
      view: { features: { reportsVisibleToOffice: true } },
    });
    expect(
      within(screen.getByRole('region', { name: t('nav.work') })).getByRole('button', {
        name: new RegExp(`^${t('nav.reports')}`),
      }),
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

describe('the New Order screen name', () => {
  it('reads New Order on the topbar button, the sidebar row and the title', async () => {
    await boot({ permissions: ['leads.view', 'leads.create'] });
    expect(newLeadButton().textContent).toContain('New Order');
    fireEvent.click(newLeadButton());
    await screen.findByLabelText(t('lead.add.party.search'));
    expect(topbarTitle()).toBe('New Order');
    expect(screen.getAllByTitle('New Order')).toHaveLength(1);
  });
});

describe('the New lead form in the sidebar', () => {
  it('is listed once under Pending Orders while it is open, and that row is the current page', async () => {
    await boot({ permissions: ['leads.view', 'leads.create'] });
    fireEvent.click(newLeadButton());
    await screen.findByLabelText(t('lead.add.party.search'));

    const rows = screen.getAllByTitle(t('lead.add.title'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.getAttribute('aria-current')).toBe('page');
  });
});

describe('the New lead form', () => {
  it('starts blank again after a lead is saved', async () => {
    const calls = await boot({ permissions: ['leads.view', 'leads.create'] });

    fireEvent.click(newLeadButton());
    await draftOneProduct();
    // Enter walks on from the quantity (through any packaging and grade list) to Add sub product,
    // and the Enter there adds the card.
    for (let step = 0; step < 3 && document.activeElement !== addSubProduct(); step += 1) {
      const here = document.activeElement as HTMLElement;
      await act(async () => {
        fireEvent.keyDown(here, { key: 'Enter' });
        await wait(0);
      });
    }
    expect(document.activeElement).toBe(addSubProduct());
    await act(async () => {
      fireEvent.keyDown(addSubProduct(), { key: 'Enter' });
      await wait(0);
    });
    expect(document.querySelector('[data-product-card]')).toBeNull();
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
    fireEvent.click(addSubProduct());
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

    const packaging = screen.getByLabelText(`${t('lead.add.draft.packaging')} — AQ-W`);
    expect(packaging.getAttribute('aria-required')).toBeNull();
    // Nothing picked and nothing required: the card adds as it is.
    expect(addSubProduct().getAttribute('aria-disabled')).toBeNull();
  });

  it('still marks packaging required when the company requires it', async () => {
    await boot({
      permissions: ['leads.view', 'leads.create'],
      view: { features: { packagingRequiredOnConvert: true } },
    });

    fireEvent.click(newLeadButton());
    await draftOneProduct();

    const packaging = screen.getByLabelText(`${t('lead.add.draft.packaging')} — AQ-W`);
    expect(packaging.getAttribute('aria-required')).toBe('true');
    // Counted but not packed: the card cannot be added yet (drawn disabled; it keeps the caret).
    expect(addSubProduct().getAttribute('aria-disabled')).toBe('true');
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

describe('Escape (R8)', () => {
  async function openOrder(): Promise<Call[]> {
    const calls = await boot({
      permissions: ['orders.view'],
      view: { orders: [ORDER], pipelines: [ORDER_PIPELINE] },
    });
    await act(async () => {
      fireEvent.click(screen.getByTitle(t('nav.orders')));
    });
    await act(async () => {
      fireEvent.click(await screen.findByText(ORDER.id));
    });
    await screen.findByRole('button', { name: t('action.backToList') });
    return calls;
  }

  /** Escape, pressed on `target` the way a person presses it; it reaches `window`. */
  async function pressEscape(target: Element = document.body): Promise<void> {
    await act(async () => {
      fireEvent.keyDown(target, { key: 'Escape' });
      await wait(0);
    });
  }

  it('goes back from an open order to the list, then to Basic Home, then nowhere', async () => {
    await openOrder();

    await pressEscape();
    expect(screen.queryByRole('button', { name: t('action.backToList') })).toBeNull();
    expect(await screen.findByText(ORDER.id)).toBeTruthy();

    await pressEscape();
    expect(topbarTitle()).toBe(t('nav.basicHome'));

    await pressEscape();
    expect(topbarTitle()).toBe(t('nav.basicHome'));
  });

  it('asks before throwing away a dispatch note, and its own Escape keeps the note', async () => {
    await openOrder();
    const note = screen.getByLabelText(t('orders.detail.dispatchNoteLabel'));
    fireEvent.change(note, { target: { value: 'Load first' } });

    await pressEscape(note);
    expect(await screen.findByText(t('action.back.discardTitle'))).toBeTruthy();

    await pressEscape();
    await waitFor(() => expect(screen.queryByText(t('action.back.discardTitle'))).toBeNull());
    expect(screen.getByLabelText(t('orders.detail.dispatchNoteLabel'))).toHaveProperty('value', 'Load first');
    expect(screen.getByRole('button', { name: t('action.backToList') })).toBeTruthy();
  });

  it('saves a weight override typed before Escape, as leaving the field by mouse does', async () => {
    const calls = await openOrder();
    const field = screen.getByLabelText<HTMLInputElement>(t('orders.detail.weightOverrideLabel'));
    // Real focus, so the shell moving it to Back is a real blur.
    act(() => field.focus());
    fireEvent.change(field, { target: { value: '175' } });

    await pressEscape(field);

    expect(
      calls.filter((call) => call.method === 'PUT' && call.url === `/api/orders/${ORDER.id}`),
    ).toHaveLength(1);
    expect(screen.queryByRole('button', { name: t('action.backToList') })).toBeNull();
  });

  it('does not leave the New lead form once something is typed on it', async () => {
    await boot({ permissions: ['leads.view', 'leads.create'] });
    fireEvent.click(newLeadButton());
    await draftOneProduct();

    await pressEscape();

    expect(topbarTitle()).toBe(t('lead.add.title'));
    expect(screen.getByLabelText(`${t('lead.add.draft.col.quantity')} — AQ-W`)).toBeTruthy();
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

/** Faces on the Pending and Final boards (R22): the Master's board answer and push. */
const face = (userId: string, displayName: string, editing: boolean) => ({
  userId,
  displayName,
  avatar: null,
  tier: 'office',
  editing,
  since: '2026-10-03T09:00:00.000Z',
});
const board = (kind: string, id: string, entries: unknown[]) => ({
  recordKind: kind,
  records: entries.length > 0 ? { [id]: entries } : {},
});
const push = (kind: string, id: string, entries: unknown[]) =>
  act(async () => {
    FakeEventSource.instances.at(-1)!.emit('presenceBoard', {
      ...board(kind, id, entries),
      forUserId: 'user-1',
    });
    await wait(0);
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
      const calls = await boot({
        permissions,
        view: { leads: [LEAD], pipelines: [LEAD_PIPELINE] },
      });
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

    it('is offered with the right to view leads alone, no export right needed (R10)', async () => {
      await openLead(['leads.view']);
      expect((await noteItem('orderNote.filling'))).toBeTruthy();
      expect((await noteItem('orderNote.dispatch'))).toBeTruthy();
    });

    it('has no note buttons on a list row: notes open from the record (2026-10-09)', async () => {
      await boot({
        permissions: ['leads.view'],
        view: { leads: [LEAD], pipelines: [LEAD_PIPELINE] },
      });
      await act(async () => {
        fireEvent.click(screen.getByTitle(t('nav.leads')));
      });
      await screen.findAllByText(PARTY.name);
      await act(async () => {
        fireEvent.click(screen.getAllByRole('button', { name: t('lead.board.tab.list') })[0]!);
      });
      expect(screen.getByText(t('lead.list.col.notes'))).toBeTruthy();
      expect(screen.queryByRole('button', { name: t('orderNote.dispatch') })).toBeNull();
    });

    it('opens a note from the board card menu (R10)', async () => {
      await boot({
        permissions: ['leads.view'],
        view: { leads: [LEAD], pipelines: [LEAD_PIPELINE] },
      });
      await act(async () => {
        fireEvent.click(screen.getByTitle(t('nav.leads')));
      });
      await screen.findAllByText(PARTY.name);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: t('lead.board.tab.board') }));
      });
      await act(async () => {
        fireEvent.click(
          (await screen.findAllByRole('button', { name: t('lead.board.cardMenu') }))[0]!,
        );
      });
      await act(async () => {
        fireEvent.click(await screen.findByRole('menuitem', { name: t('orderNote.filling') }));
      });

      expect((await screen.findAllByText(t('orderNote.pendingOrderNo'))).length).toBeGreaterThan(0);
    });

    it('the board card menu trigger announces a menu and keeps Enter to itself', async () => {
      await boot({
        permissions: ['leads.view'],
        view: { leads: [LEAD], pipelines: [LEAD_PIPELINE] },
      });
      await act(async () => {
        fireEvent.click(screen.getByTitle(t('nav.leads')));
      });
      await screen.findAllByText(PARTY.name);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: t('lead.board.tab.board') }));
      });
      const trigger = (
        await screen.findAllByRole('button', { name: t('lead.board.cardMenu') })
      )[0]!;
      expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
      // Enter on the trigger must not reach the card, whose own handler opens the record.
      await act(async () => {
        fireEvent.keyDown(trigger, { key: 'Enter' });
      });
      expect(screen.queryByRole('button', { name: t('lead.board.tab.board') })).not.toBeNull();
      await act(async () => {
        fireEvent.click(trigger);
      });
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
    });

    describe('Send to Printroom', () => {
      async function openNote(permissions: string[]): Promise<Call[]> {
        const calls = await boot({
          permissions,
          view: { leads: [LEAD], pipelines: [LEAD_PIPELINE] },
          route: (call) => {
            const path = call.url.split('?')[0];
            if (path === '/api/print-jobs' && call.method === 'POST')
              return json({ id: 'sent' }, 201);
            if (path === '/api/print-jobs')
              return json({ jobs: [], nextCursor: null, waitingCount: 0 });
            if (path === '/api/print-stations') return json([]);
            return undefined;
          },
        });
        await act(async () => {
          fireEvent.click(screen.getByTitle(t('nav.leads')));
        });
        await act(async () => {
          fireEvent.click((await screen.findAllByText(PARTY.name))[0]!);
        });
        await screen.findByText(t('lead.detail.lineItems'));
        fireEvent.click((await noteItem('orderNote.filling')));
        await screen.findByLabelText(t('orderNote.copies'));
        return calls;
      }

      it('is offered only with print.send', async () => {
        await openNote(['leads.view', 'leads.export']);
        expect(screen.queryByRole('button', { name: t('orderNote.sendToPrintroom') })).toBeNull();
        cleanup();

        await openNote(['leads.view', 'leads.export', 'print.send']);
        expect(screen.getByRole('button', { name: t('orderNote.sendToPrintroom') })).toBeTruthy();
      });

      it("posts the pending order to this panel's server, which forwards it to the Master", async () => {
        const calls = await openNote(['leads.view', 'leads.export', 'print.send']);
        fireEvent.change(screen.getByLabelText(t('orderNote.copies')), { target: { value: '2' } });
        fireEvent.click(screen.getByRole('button', { name: t('orderNote.sendToPrintroom') }));

        const dialog = await screen.findByRole('dialog');
        fireEvent.click(within(dialog).getByRole('button', { name: t('printroom.dialog.send') }));

        await waitFor(() =>
          expect(
            calls.some((call) => call.method === 'POST' && call.url === '/api/print-jobs'),
          ).toBe(true),
        );
        const post = calls.find(
          (call) => call.method === 'POST' && call.url === '/api/print-jobs',
        )!;
        expect(post.body).toMatchObject({
          kind: 'filling',
          source: 'lead',
          sourceId: LEAD.id,
          copies: 2,
        });
      });

      it("says the Master is not reachable when the panel's server answers 503, and the local Print still works", async () => {
        const printPage = vi.fn().mockResolvedValue({ ok: true });
        (window as Window & { orderbook?: unknown }).orderbook = {
          shellVersion: 't',
          applyUpdate: vi.fn(),
          printPage,
        };
        const calls = await boot({
          permissions: ['leads.view', 'leads.export', 'print.send'],
          view: { leads: [LEAD], pipelines: [LEAD_PIPELINE] },
          route: (call) => {
            const path = call.url.split('?')[0];
            if (path === '/api/print-jobs' && call.method === 'POST') {
              return json(
                { error: 'unavailable', message: 'Not connected', messageKey: 'error.unavailable' },
                503,
              );
            }
            if (path === '/api/print-jobs')
              return json({ jobs: [], nextCursor: null, waitingCount: 0 });
            if (path === '/api/print-stations') return json([]);
            return undefined;
          },
        });
        await act(async () => {
          fireEvent.click(screen.getByTitle(t('nav.leads')));
        });
        await act(async () => {
          fireEvent.click((await screen.findAllByText(PARTY.name))[0]!);
        });
        await screen.findByText(t('lead.detail.lineItems'));
        fireEvent.click((await noteItem('orderNote.filling')));
        fireEvent.click(
          await screen.findByRole('button', { name: t('orderNote.sendToPrintroom') }),
        );
        const dialog = await screen.findByRole('dialog');
        fireEvent.click(within(dialog).getByRole('button', { name: t('printroom.dialog.send') }));

        expect(await screen.findByText(t('printroom.dialog.offline'))).toBeTruthy();
        expect(
          calls.filter((call) => call.method === 'POST' && call.url === '/api/print-jobs'),
        ).toHaveLength(1);

        fireEvent.click(within(dialog).getByRole('button', { name: t('common.cancel') }));
        fireEvent.click(screen.getByRole('button', { name: t('orderNote.print') }));
        await waitFor(() => expect(printPage).toHaveBeenCalled());
      });
    });

    it('opens the note from the local snapshot, headed "Pending Order No.", and back returns to the lead', async () => {
      await openLead(['leads.view', 'leads.export']);
      fireEvent.click((await noteItem('orderNote.filling')));

      expect((await screen.findAllByText(t('orderNote.pendingOrderNo'))).length).toBeGreaterThan(0);
      expect(screen.queryByText(t('orderNote.orderId'))).toBeNull();
      expect(screen.getAllByText(LEAD.id).length).toBeGreaterThan(0);

      fireEvent.click(screen.getByRole('button', { name: t('action.backToList') }));
      expect(await screen.findByText(t('lead.detail.lineItems'))).toBeTruthy();
    });

    it('prints the copies asked for, and sends no write for the vehicle number', async () => {
      const printPage = vi.fn().mockResolvedValue({ ok: true });
      (window as Window & { orderbook?: unknown }).orderbook = {
        shellVersion: 'test',
        applyUpdate: vi.fn(),
        printPage,
      };
      const calls = await openLead(['leads.view', 'leads.export']);
      fireEvent.click((await noteItem('orderNote.dispatch')));

      const field = await screen.findByLabelText(t('orderNote.vehicleNo'));
      expect((field as HTMLInputElement).disabled).toBe(false);
      await act(async () => {
        fireEvent.change(field, { target: { value: 'gj 03 ab 4471' } });
        fireEvent.blur(field);
        await wait(0);
      });

      fireEvent.change(screen.getByLabelText(t('orderNote.copies')), { target: { value: '4' } });
      fireEvent.click(screen.getByRole('button', { name: t('orderNote.print') }));
      await waitFor(() =>
        expect(printPage).toHaveBeenLastCalledWith({ deviceName: undefined, copies: 4 }),
      );
      expect(
        calls.filter((call) => call.method !== 'GET' && call.url.startsWith('/api/leads')),
      ).toEqual([]);
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

  it('puts a face on a pending order, in its row and on its card, and takes it off again', async () => {
    await boot({
      permissions: ['leads.view'],
      view: { leads: [LEAD], pipelines: [LEAD_PIPELINE] },
      route: ({ url }) =>
        url === '/api/presence/board?kind=lead'
          ? json(board('lead', LEAD.id, [face('user-9', 'Ravi Kumar', true)]))
          : undefined,
    });
    await act(async () => {
      fireEvent.click(screen.getByTitle(t('nav.leads')));
    });

    // The list row (the table: the board has none), from the first read.
    const listed = () => within(screen.getByRole('table'));
    expect(await screen.findByTitle(t('presence.editing', { name: 'Ravi Kumar' }))).toBeTruthy();
    expect(listed().getByTitle(t('presence.editing', { name: 'Ravi Kumar' }))).toBeTruthy();

    // The Master's push replaces it.
    await push('lead', LEAD.id, [face('user-8', 'Meera', false)]);
    expect(await screen.findByTitle(t('presence.viewing', { name: 'Meera' }))).toBeTruthy();
    expect(listed().getByTitle(t('presence.viewing', { name: 'Meera' }))).toBeTruthy();
    expect(screen.queryByTitle(t('presence.editing', { name: 'Ravi Kumar' }))).toBeNull();

    // The card on the board tab carries the same face.
    await act(async () => {
      fireEvent.click(screen.getByText(t('lead.board.tab.board')));
    });
    expect(await screen.findByTitle(t('presence.viewing', { name: 'Meera' }))).toBeTruthy();

    await push('lead', LEAD.id, []);
    expect(screen.queryByTitle(t('presence.viewing', { name: 'Meera' }))).toBeNull();
  });

  it('shows nobody while the Master cannot be asked, and does not call it an error', async () => {
    await boot({
      permissions: ['leads.view'],
      view: { leads: [LEAD], pipelines: [LEAD_PIPELINE] },
      route: ({ url }) =>
        url === '/api/presence/board?kind=lead' ? json({ error: 'offline' }, 503) : undefined,
    });
    await act(async () => {
      fireEvent.click(screen.getByTitle(t('nav.leads')));
    });
    expect((await screen.findAllByText(PARTY.name)).length).toBeGreaterThan(0);
    expect(screen.queryByRole('alert')).toBeNull();
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
    expect(
      await screen.findByText(t('lead.numbered.toast', { number: 'PO/2026-27/00012' })),
    ).toBeTruthy();

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
    id: 'line-1',
    variantId: 'var-1',
    productId: 'prod-1',
    productName: 'Rustic Wood',
    categoryName: 'Duragres',
    size: '600x600',
    brandName: null,
    variantLabel: 'Ivory',
    colour: null,
    grade: 'Std',
    packaging: 'Box',
    quantity: 12,
    weightKg: 2,
    lineWeightKg: 24,
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

  it('is offered with the right to view orders alone, no export right needed (R10)', async () => {
    await openOrder(['orders.view']);
    await screen.findByText(t('orders.detail.products'));
    expect(screen.getByRole('button', { name: t('orderNote.filling') })).toBeTruthy();
    expect(screen.getByRole('button', { name: t('orderNote.dispatch') })).toBeTruthy();
  });

  it('has a Notes column and no note buttons on a list row (2026-10-09)', async () => {
    await boot({
      permissions: ['orders.view'],
      view: { orders: [NOTE_ORDER], pipelines: [ORDER_PIPELINE] },
    });
    await act(async () => {
      fireEvent.click(screen.getByTitle(t('nav.orders')));
    });
    await screen.findByText(ORDER.id);
    expect(screen.getByText(t('lead.list.col.notes'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('orderNote.filling') })).toBeNull();
  });

  it('opens a preview with the order on it, and back returns to the order', async () => {
    await openOrder(['orders.view', 'orders.export']);
    fireEvent.click(await screen.findByRole('button', { name: t('orderNote.filling') }));

    // Twice: the preview, and the copy that print shows.
    expect((await screen.findAllByText(pageLabel)).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Rustic Wood 600x600').length).toBeGreaterThan(0);

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
    await waitFor(() =>
      expect(printPage).toHaveBeenLastCalledWith({ deviceName: undefined, copies: 1 }),
    );

    fireEvent.change(printer, { target: { value: 'HP Laser' } });
    fireEvent.click(screen.getByRole('button', { name: t('orderNote.print') }));
    await waitFor(() =>
      expect(printPage).toHaveBeenLastCalledWith({ deviceName: 'HP Laser', copies: 1 }),
    );
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

    const writes = calls.filter(
      (call) => call.method === 'PUT' && call.url === `/api/orders/${ORDER.id}`,
    );
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
    id: 'room-1',
    kind: 'group',
    name: 'Dispatch desk',
    description: null,
    announceOnly: false,
    archivedAt: null,
    myRole: 'member',
    muted: false,
    lastSeq: 4,
    lastReadSeq: 1,
    unread: 3,
    mentionUnread: 0,
    memberCount: 2,
    lastMessageAt: '2026-10-03T09:00:00.000Z',
    lastMessage: null,
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

  const bootChat = (
    permissions: string[],
    extra?: Boot['route'],
    view: Record<string, unknown> = {},
  ) =>
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
        new KeyboardEvent('keydown', {
          key: 'c',
          code: 'KeyC',
          altKey: true,
          bubbles: true,
          cancelable: true,
        }),
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
      FakeEventSource.instances
        .at(-1)!
        .emit('chat', { kind: 'room', roomId: 'room-1', forUserId: 'user-1' });
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
    expect(
      (await screen.findAllByRole('heading', { name: t('chat.share.title') })).length,
    ).toBeGreaterThan(0);
    expect(await screen.findByText('Dispatch desk')).toBeTruthy();
  });

  describe('a record chip', () => {
    const chipMessage = (id: string) => ({
      id: 'CM1',
      roomId: 'room-1',
      seq: 1,
      kind: 'text',
      author: { id: 'user-2', displayName: 'Bina', avatar: null, tier: 'office' },
      body: 'please look',
      refs: [{ kind: 'order', id, label: id, partyName: 'Sharma Traders', restricted: false }],
      mentions: [],
      system: null,
      createdAt: new Date().toISOString(),
      editedAt: null,
      deletedAt: null,
      pinnedAt: null,
      pinnedBy: null,
      task: null,
      clientId: null,
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
      fireEvent.click(
        (await screen.findByText(new RegExp(`${orderId} . Sharma Traders`))).closest('button')!,
      );
      return calls;
    }

    it("opens an order this panel's view does not hold by fetching it from the Master", async () => {
      const calls = await openChip(
        'ORD-9',
        json({ ...ORDER, id: 'ORD-9', partyName: 'Patel Tiles' }),
      );

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

describe('the Printroom (1.3 Phase 7)', () => {
  const JOB = {
    id: 'job-1',
    kind: 'filling',
    source: 'lead',
    sourceId: 'LD0000000001',
    sourceNumber: 'PO/2026-27/00001',
    partyName: 'Shree Ceramics',
    copies: 2,
    note: null,
    targetStation: null,
    status: 'queued',
    sender: { id: 'user-2', displayName: 'Bina', avatar: null, tier: 'office' },
    requestedFrom: 'lan',
    requestedAt: '2026-10-03T09:00:00.000Z',
    claimedAt: null,
    claimedStationName: null,
    printedBy: null,
    printedAt: null,
    printerName: null,
    printedStationName: null,
    cancelledBy: null,
    cancelledAt: null,
    hasDocument: true,
  };

  const printRoutes = (call: Call): Response | undefined => {
    const path = call.url.split('?')[0];
    if (path === '/api/print-jobs') return json({ jobs: [JOB], nextCursor: null, waitingCount: 3 });
    if (path === '/api/print-stations') return json([]);
    return undefined;
  };

  const bootPrint = (
    permissions: string[],
    extra?: Boot['route'],
    view: Record<string, unknown> = {},
  ) => boot({ permissions, view, route: (call) => extra?.(call) ?? printRoutes(call) });

  const row = () => screen.queryByTitle(t('nav.printroom'));
  const gets = (calls: Call[], path: string) =>
    calls.filter((call) => call.method === 'GET' && call.url.split('?')[0] === path).length;

  it('is a Work row only with print.send or print.station, carrying the waiting count', async () => {
    await bootPrint(['print.send']);
    await waitFor(() => expect(row()?.textContent).toContain('3'));
    cleanup();

    await bootPrint(['print.station']);
    await waitFor(() => expect(row()?.textContent).toContain('3'));
    cleanup();

    const calls = await boot({ permissions: ['leads.view'] });
    expect(row()).toBeNull();
    expect(gets(calls, '/api/print-jobs')).toBe(0);
  });

  it('opens on Alt+P and lists the jobs, with no snapshot needed', async () => {
    await bootPrint(['print.station']);
    await waitFor(() => expect(row()).not.toBeNull());

    await waitFor(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'p',
          code: 'KeyP',
          altKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(topbarTitle()).toBe(t('printroom.filter.waiting'));
    });
    expect(await screen.findByText('Shree Ceramics')).toBeTruthy();
  });

  it('counts again when a print frame arrives and when the stream comes back, without opening a second stream', async () => {
    const calls = await bootPrint(['print.station']);
    await waitFor(() => expect(gets(calls, '/api/print-jobs')).toBeGreaterThan(0));
    const before = gets(calls, '/api/print-jobs');

    await act(async () => {
      FakeEventSource.instances.at(-1)!.emit('print', { ...JOB, forUserId: 'user-1' });
      await wait(700);
    });
    expect(gets(calls, '/api/print-jobs')).toBeGreaterThan(before);

    const afterPush = gets(calls, '/api/print-jobs');
    await act(async () => {
      FakeEventSource.instances.at(-1)!.emit('error', {});
      FakeEventSource.instances.at(-1)!.emit('open', {});
      await wait(700);
    });
    expect(gets(calls, '/api/print-jobs')).toBeGreaterThan(afterPush);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("says the Master is not reachable when the panel's server answers 503", async () => {
    await bootPrint(['print.station'], (call) =>
      call.url.split('?')[0] === '/api/print-jobs'
        ? json(
            { error: 'unavailable', message: 'Not connected', messageKey: 'error.unavailable' },
            503,
          )
        : undefined,
    );
    await act(async () => {
      fireEvent.click(await screen.findByTitle(t('nav.printroom')));
      await wait(0);
    });
    expect(await screen.findByText(t('printroom.error.offline'))).toBeTruthy();
  });
});

describe('the faces on the Final orders board (R22)', () => {
  it('puts a face on a final order row', async () => {
    await boot({
      permissions: ['orders.view'],
      view: { orders: [ORDER], pipelines: [ORDER_PIPELINE] },
      route: ({ url }) =>
        url === '/api/presence/board?kind=order'
          ? json(board('order', ORDER.id, [face('user-9', 'Ravi Kumar', false)]))
          : undefined,
    });
    await act(async () => {
      fireEvent.click(screen.getByTitle(t('nav.orders')));
    });
    expect(await screen.findByTitle(t('presence.viewing', { name: 'Ravi Kumar' }))).toBeTruthy();
    await push('order', ORDER.id, []);
    expect(screen.queryByTitle(t('presence.viewing', { name: 'Ravi Kumar' }))).toBeNull();
  });

  it('shows three faces and a +N on a crowded row, not four', async () => {
    const crowd = Array.from({ length: 5 }, (_, at) =>
      face('user-' + (10 + at), 'Viewer ' + at, false),
    );
    await boot({
      permissions: ['orders.view'],
      view: { orders: [ORDER], pipelines: [ORDER_PIPELINE] },
      route: ({ url }) =>
        url === '/api/presence/board?kind=order'
          ? json(board('order', ORDER.id, crowd))
          : undefined,
    });
    await act(async () => {
      fireEvent.click(screen.getByTitle(t('nav.orders')));
    });
    const row = within(await screen.findByRole('table'));
    expect(await row.findByTitle(t('presence.viewing', { name: 'Viewer 2' }))).toBeTruthy();
    expect(row.queryByTitle(t('presence.viewing', { name: 'Viewer 3' }))).toBeNull();
    expect(row.getByLabelText(t('presence.more', { count: 2 }))).toBeTruthy();
  });
});

describe('an Office on another version than its Master (1.4 R7e)', () => {
  function bootWith(masterVersion: string | null, permissions: string[] = ['leads.view']) {
    routeFetch(({ url }) => {
      const path = url.split('?')[0] ?? url;
      if (path === '/api/connection') return json({ ...CONNECTION, masterVersion });
      if (path === '/api/session') {
        return json({ session: panelSession(permissions) });
      }
      if (path === '/api/sync')
        return json({ ...CONNECTION, masterVersion, pendingCount: 0, rejections: [] });
      if (path === '/api/notifications') return json({ items: [], unreadCount: 0 });
      if (path === '/api/updates/available') {
        return json({
          current: '1.2.0',
          available: {
            version: '1.3.0',
            file: 'OrderBook-Office-1.3.0-Setup.exe',
            sha256: 'a'.repeat(64),
            sizeBytes: 1000,
            releasedAt: '2026-10-03T00:00:00.000Z',
            panel: 'office',
          },
        });
      }
      if (path === '/api/updates/progress') return json({ phase: 'idle' });
      return undefined;
    });
    return loadApp('office');
  }

  it('blocks the app with "Update needed" once it knows the Master is newer, and offers the update to anyone', async () => {
    vi.stubGlobal('__APP_VERSION__', '1.2.0');
    const App = await bootWith('1.3.0');
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );

    expect(await screen.findByRole('heading', { name: t('updates.required.title') })).toBeTruthy();
    expect(
      screen.getByText(t('updates.required.body', { mine: '1.2.0', master: '1.3.0' })),
    ).toBeTruthy();
    // No sidebar, no footer: nothing of the app is open behind it.
    expect(document.querySelector('.ob-footer')).toBeNull();
    expect(screen.queryByRole('region', { name: t('nav.work') })).toBeNull();
    // A person with no settings right can still start the update: it is mandatory.
    expect(await screen.findByRole('button', { name: t('updates.installNow') })).toBeTruthy();
    expect(screen.getByRole('button', { name: t('action.signOut') })).toBeTruthy();
  });

  it('opens the app when the versions match', async () => {
    vi.stubGlobal('__APP_VERSION__', '1.3.0');
    const App = await bootWith('1.3.0');
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    await waitFor(() => expect(document.querySelector('.ob-footer')).not.toBeNull());
    expect(screen.queryByRole('heading', { name: t('updates.required.title') })).toBeNull();
  });

  it('does not block when the Master version is not known yet: offline work goes on', async () => {
    vi.stubGlobal('__APP_VERSION__', '1.2.0');
    const App = await bootWith(null);
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    await waitFor(() => expect(document.querySelector('.ob-footer')).not.toBeNull());
    expect(screen.queryByRole('heading', { name: t('updates.required.title') })).toBeNull();
  });

  it('also holds an Office that is ahead of its Master, waiting, with no install to offer', async () => {
    vi.stubGlobal('__APP_VERSION__', '1.4.0');
    const App = await bootWith('1.3.0');
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );

    expect(await screen.findByRole('heading', { name: t('updates.waiting.title') })).toBeTruthy();
    expect(
      screen.getByText(t('updates.waiting.body', { mine: '1.4.0', master: '1.3.0' })),
    ).toBeTruthy();
    // Nothing of the app, and nothing to install: only the Master can be updated for this.
    expect(document.querySelector('.ob-footer')).toBeNull();
    expect(screen.queryByRole('button', { name: t('updates.installNow') })).toBeNull();
    expect(screen.getByRole('button', { name: t('action.signOut') })).toBeTruthy();
  });
});

describe('Party lists mark who can see a party (party visibility)', () => {
  const synced = { ...PARTY, sync: { hlc: 'h1' } };
  const second = { ...synced, id: 'party-2', partyCode: 'P-002', name: 'Patel Tiles' };
  const third = { ...synced, id: 'party-3', partyCode: 'P-003', name: 'Joshi Sanitary' };

  async function openParties(view: Record<string, unknown>): Promise<void> {
    await boot({
      permissions: ['parties.view'],
      view: { parties: [synced, second, third], products: [], ...view },
    });
    fireEvent.click(await screen.findByTitle(t('nav.parties')));
    await screen.findByText('Patel Tiles');
  }

  it('says Private for one holder and Shared with N for more, and nothing for an open or unlisted party', async () => {
    await openParties({ partyAccessCounts: { 'party-1': 1, 'party-2': 3 } });

    const row = (name: string) => screen.getByText(name).closest('tr')!;
    expect(within(row('Sharma Traders')).getByText(t('partyVisibility.private'))).toBeTruthy();
    expect(
      within(row('Patel Tiles')).getByText(t('partyVisibility.shared', { count: 3 })),
    ).toBeTruthy();
    // No entry: open, or newer than the snapshot. Nothing is drawn rather than a guess.
    expect(within(row('Joshi Sanitary')).queryByText(t('partyVisibility.private'))).toBeNull();
    expect(within(row('Joshi Sanitary')).queryByText(/Shared with/)).toBeNull();
  });

  it('draws no marker at all from a snapshot an older Master sent (no counts)', async () => {
    await openParties({});
    expect(screen.queryByText(t('partyVisibility.private'))).toBeNull();
    expect(screen.queryByText(/Shared with/)).toBeNull();
  });
});

describe('Notice board in the Office sidebar (Oct 7)', () => {
  it('offers the Notice board with notices.view, and management beside it only with notices.manage', async () => {
    await boot({ permissions: ['notices.view'] });
    expect(await screen.findByTitle(t('nav.notices'))).toBeTruthy();
    expect(screen.queryByTitle(t('nav.noticesManage'))).toBeNull();
  });

  it('offers management to a manager, right after the board', async () => {
    await boot({ permissions: ['notices.view', 'notices.manage'] });
    await screen.findByTitle(t('nav.notices'));
    const labels = [...document.querySelectorAll('.ob-navitem-main')].map((row) =>
      row.getAttribute('title'),
    );
    expect(labels.indexOf(t('nav.noticesManage'))).toBe(labels.indexOf(t('nav.notices')) + 1);
  });

  it('offers neither without the permissions', async () => {
    await boot({ permissions: ['leads.view'] });
    await screen.findByTitle(t('nav.leads'));
    expect(screen.queryByTitle(t('nav.notices'))).toBeNull();
    expect(screen.queryByTitle(t('nav.noticesManage'))).toBeNull();
  });
});

describe('the To-do list (2026-10-08, the Lists module)', () => {
  const TASK = {
    id: 'td-1',
    text: 'Load the truck',
    createdByName: 'Owner',
    createdAt: '2026-10-08T10:00:00.000Z',
    expiresAt: null,
    expireAfterHours: null,
    completedAt: null,
    marks: [],
  };

  it('opens on the tasks from the Master, re-reads them on a todo change, and has no form without todos.manage', async () => {
    const calls = await boot({
      permissions: ['todos.view'],
      route: (call) => (call.url.split('?')[0] === '/api/todos' ? json([TASK]) : undefined),
    });
    await act(async () => {
      fireEvent.click(await screen.findByTitle(t('nav.lists')));
    });
    expect(await screen.findByText('Load the truck')).toBeTruthy();
    expect(screen.queryByRole('form', { name: t('todos.add.title') })).toBeNull();
    const reads = () => calls.filter((call) => call.url === '/api/todos').length;
    const before = reads();

    // Somebody else marked a task: the change frame reaches this panel's stream.
    await act(async () => {
      FakeEventSource.instances.at(-1)!.emit('change', { entity: 'todo', action: 'updated', id: 'td-1', payload: null });
    });
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
  });

  it('is absent without todos.view', async () => {
    await boot({ permissions: ['leads.view'] });
    await screen.findByTitle(t('nav.leads'));
    expect(screen.queryByTitle(t('nav.lists'))).toBeNull();
  });
});

describe('V6: unread notices pop up on sign-in', () => {
  const base = {
    tenantId: 'tenant-1',
    body: 'Read me.',
    pinned: false,
    showUntil: null,
    audience: { kind: 'all' },
    authorId: null,
    authorName: null,
    updatedAt: '2026-09-20T09:00:00.000Z',
    version: 1,
  };
  const notices = [
    {
      ...base,
      id: 'NT1',
      title: 'Older important',
      priority: 'important',
      createdAt: '2026-09-20T09:00:00.000Z',
      readByMe: false,
    },
    {
      ...base,
      id: 'NT2',
      title: 'Newer important',
      priority: 'important',
      createdAt: '2026-09-22T09:00:00.000Z',
      readByMe: false,
    },
    {
      ...base,
      id: 'NT3',
      title: 'Just news',
      priority: 'normal',
      createdAt: '2026-09-23T09:00:00.000Z',
      readByMe: false,
    },
    {
      ...base,
      id: 'NT4',
      title: 'Already read',
      priority: 'important',
      createdAt: '2026-09-23T09:00:00.000Z',
      readByMe: true,
    },
    {
      ...base,
      id: 'NT5',
      title: 'Basic Home only',
      priority: 'important',
      createdAt: '2026-09-24T09:00:00.000Z',
      readByMe: false,
      showAtSignIn: false,
    },
  ];
  const popUp = () => screen.queryByRole('dialog', { name: t('notices.signIn.title') });

  it('lists this person’s unread notices placed at sign-in, important first then newest, and marks them read', async () => {
    const calls = await boot({
      permissions: ['notices.view'],
      view: { notices },
      route: (call) => (call.url === '/api/notices/read' ? json({ unreadCount: 0 }) : undefined),
    });
    await waitFor(() => expect(popUp()).not.toBeNull());
    // The ordinary one too (2026-10-08); the read one and the Basic Home only one not.
    expect(
      within(popUp()!)
        .getAllByRole('listitem')
        .map((item) => item.getAttribute('data-notice')),
    ).toEqual(['NT2', 'NT1', 'NT3']);
    // The Important pill on the important ones only.
    expect(within(popUp()!).getAllByText(t('notices.priority.important'))).toHaveLength(2);

    await act(async () => {
      fireEvent.click(within(popUp()!).getByRole('button', { name: t('notices.signIn.markRead') }));
    });

    expect(popUp()).toBeNull();
    await waitFor(() =>
      expect(calls.find((call) => call.url === '/api/notices/read')?.body).toEqual({
        ids: ['NT2', 'NT1', 'NT3'],
      }),
    );
  });

  it('shows nothing when the company turned it off, and the band on Basic Home leaves out the sign-in only one', async () => {
    await boot({
      permissions: ['notices.view'],
      view: {
        notices: [...notices, { ...notices[0], id: 'NT6', title: 'Sign-in only', showOnHome: false }],
        features: { noticesAtSignIn: false },
      },
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(popUp()).toBeNull();
    // An office-tier person lands on Basic Home: the band is there, with every notice placed on it.
    const band = await screen.findByRole('region', { name: t('notices.slideshow.label') });
    // NT1, NT2, NT3 and NT5 unread, NT4 read; NT6 is for sign-in only.
    expect(within(band).getAllByRole('button', { name: /^Show notice/ })).toHaveLength(5);
  });

  it('waits for this person’s own snapshot while the link is up, not the last person’s cache', async () => {
    // The cache on this PC was built for somebody else, so every notice in it reads as unread.
    const cached = notices.map((notice) => ({ ...notice, readByMe: false }));
    await boot({ permissions: ['notices.view'], view: { notices: cached, builtForUserId: 'user-0' } });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(popUp()).toBeNull();

    // Their own: NT2 read as well as NT4.
    const own = notices.map((notice) => (notice.id === 'NT2' ? { ...notice, readByMe: true } : notice));
    await sendSnapshot(snapshot({ notices: own, builtForUserId: 'user-1' }));
    await waitFor(() => expect(popUp()).not.toBeNull());
    expect(
      within(popUp()!)
        .getAllByRole('listitem')
        .map((item) => item.getAttribute('data-notice')),
    ).toEqual(['NT1', 'NT3']);
  });

  it('decides on the last person’s cache when the link is down: it is all there is', async () => {
    await boot({
      permissions: ['notices.view'],
      view: { notices, builtForUserId: 'user-0' },
      route: (call) =>
        call.url === '/api/connection' ? json({ ...CONNECTION, state: 'disconnected' }) : undefined,
    });
    await waitFor(() => expect(popUp()).not.toBeNull());
  });

  it('never shows without notices.view, even with notices in the snapshot', async () => {
    await boot({ permissions: [], view: { notices } });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(popUp()).toBeNull();
  });
});

describe('W2: a renamed colour reads by its current label on the Office records', () => {
  /** "Ivory" renamed to "Antique Ivory" in Fields; lines still store the value "Ivory". */
  const IVORY = {
    id: 'opt-ivory',
    listKey: 'stock.colour',
    value: 'Ivory',
    label: 'Antique Ivory',
    sequence: 1,
    isActive: true,
    hex: '#F1E8CF',
  };
  const LINE = {
    id: 'li-ivory',
    productId: PRODUCT.id,
    variantId: 'var-1',
    productName: 'E.W.C - S TRAP',
    categoryName: CATEGORY.name,
    categoryCode: null,
    brandName: null,
    alias: null,
    code: 'WC-0005',
    variantLabel: null,
    colour: 'Ivory',
    size: null,
    weightKg: null,
    packaging: null,
    grade: null,
    sequence: 1,
    fromPartyVariant: false,
    notes: null,
    quantity: 4,
    lineWeightKg: null,
  };

  it('new-order detail (LeadRecordView)', async () => {
    const lead = {
      id: 'LD-IV',
      partyId: PARTY.id,
      partyName: PARTY.name,
      ownerId: 'user-1',
      stageId: 'stage-lead',
      stageName: 'New',
      sourcePlatform: null,
      followUpDate: null,
      partyWiseMode: false,
      notes: null,
      customFields: {},
      incomplete: false,
      missingFields: [],
      convertedOrderId: null,
      items: [LINE],
      timeline: [],
      totalWeightKg: 0,
      linesWithoutWeight: 1,
      createdAt: '2026-09-24T00:00:00.000Z',
      sync: { hlc: 'h1', fieldHlc: {} },
    };
    const pipeline = {
      id: 'pipe-leads',
      kind: 'lead',
      name: 'Leads',
      stages: [{ id: 'stage-lead', name: 'New', sequence: 1, isDefault: true, isTerminal: false }],
    };
    await boot({
      permissions: ['leads.view'],
      view: { leads: [lead], pipelines: [pipeline], optionLists: [IVORY] },
    });
    await act(async () => {
      fireEvent.click(screen.getByTitle(t('nav.leads')));
    });
    await act(async () => {
      fireEvent.click((await screen.findAllByText(PARTY.name))[0]!);
    });
    expect(await screen.findByText('Antique Ivory')).toBeTruthy();
    expect(screen.queryByText('Ivory', { exact: true })).toBeNull();
  });

  it('final-order detail (OrderDetailBody)', async () => {
    await boot({
      permissions: ['orders.view'],
      view: {
        orders: [{ ...ORDER, items: [LINE] }],
        pipelines: [ORDER_PIPELINE],
        optionLists: [IVORY],
      },
    });
    await act(async () => {
      fireEvent.click(screen.getByTitle(t('nav.orders')));
    });
    await act(async () => {
      fireEvent.click(await screen.findByText(ORDER.id));
    });
    expect(await screen.findByText('Antique Ivory')).toBeTruthy();
    expect(screen.queryByText('Ivory', { exact: true })).toBeNull();
  });
});
