/**
 * The notice board on the Office Panel, booted whole in jsdom (`panel-harness.ts`).
 *
 * The Office reads its notices from the snapshot (`view.notices`, scoped by the Master
 * to the person it was built for) and marks them read through its own server, which
 * forwards to the Master. That forward is online-only, so a read made offline is kept
 * per person in this window (`office/web/src/noticeReads.ts`) and sent on reconnect.
 * What these pin:
 *
 *  · the sidebar badge counts the unread notices, and drops the moment one is marked;
 *  · a read made offline is not lost: no request while the link is down, the read is
 *    sent when the status turns connected, and the badge has already dropped;
 *  · a read queued by one person is never sent, or counted, for the next person;
 *  · the management screen reads the manage list and writes through the panel's API;
 *  · the Dashboard shows an important notice and opens the board;
 *  · Basic Home turns over every notice placed there, says so when there are none, and follows
 *    the company's switch (2026-10-08);
 *  · "Sell today" pops up from the snapshot after the unread notices, offline too, and its
 *    products (or the snapshot's sub products with photos) fill the product band (2026-10-08).
 */

import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

function notice(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `Notice ${id}`,
    body: `Body of ${id}`,
    priority: 'normal',
    pinned: false,
    showUntil: null,
    audience: { kind: 'all' },
    authorId: 'boss',
    authorName: 'Boss',
    createdAt: '2026-10-06T09:00:00.000Z',
    updatedAt: '2026-10-06T09:00:00.000Z',
    version: 1,
    readByMe: false,
    ...overrides,
  };
}

function snapshot(notices: unknown[], features: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    ...extra,
    features,
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
    dashboard: { asOf: '2026-10-06T00:00:00.000Z' },
    permissions: [],
    serverHlc: '0',
    serverTime: '2026-10-06T00:00:00.000Z',
    pendingCount: 0,
    notices,
    ...extra,
  };
}

interface Boot {
  permissions: string[];
  notices: unknown[];
  userId?: string;
  roleTier?: string;
  connection?: Partial<typeof CONNECTION>;
  route?: (call: Call) => Response | undefined;
  /**
   * The company's switches in the snapshot. The sign-in pop-up is off unless a test turns it on:
   * since 2026-10-08 it lists every unread notice, so it would stand over the board these tests
   * read. It has its own tests (`sign-in-notices.test.tsx`, the V6 block in `office-shell`).
   */
  features?: Record<string, unknown>;
  /** Anything else the snapshot carries (`sellToday`, `products`). */
  extra?: Record<string, unknown>;
}

async function boot({
  permissions,
  notices,
  userId = 'user-1',
  roleTier = 'admin',
  connection = {},
  route,
  features = { noticesAtSignIn: false },
  extra = {},
}: Boot) {
  const calls = routeFetch((call) => {
    const answer = route?.(call);
    if (answer) return answer;
    const path = call.url.split('?')[0] ?? call.url;
    if (path === '/api/connection') return json({ ...CONNECTION, ...connection });
    if (path === '/api/session') {
      return json({
        session: {
          userId,
          username: userId,
          displayName: userId,
          roleId: 'role-admin',
          roleName: 'Admin',
          roleTier,
          permissions,
          offline: false,
          signedInAt: '2026-10-06T00:00:00.000Z',
        },
      });
    }
    if (path === '/api/sync') return json({ ...CONNECTION, pendingCount: 0, rejections: [] });
    if (path === '/api/notifications') return json({ items: [], unreadCount: 0 });
    if (path === '/api/notices/read' && call.method === 'POST') return json({ unreadCount: 0 });
    return undefined;
  });

  const App = await loadApp('office');
  render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  await waitFor(() => expect(document.querySelector('.ob-footer')).not.toBeNull());
  await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
  await act(async () => {
    FakeEventSource.instances.at(-1)!.emit('snapshot', snapshot(notices, features, extra));
  });
  return calls;
}

const readCalls = (calls: Call[]) =>
  calls.filter((call) => call.url === '/api/notices/read' && call.method === 'POST');

async function badge(): Promise<string | null> {
  const row = await screen.findByTitle(t('nav.notices'));
  return row.querySelector('.count')?.textContent ?? null;
}

async function openBoard(): Promise<void> {
  fireEvent.click(await screen.findByTitle(t('nav.notices')));
  await screen.findByText('Notice n1');
}

beforeEach(() => {
  installBrowserStubs();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as { orderbook?: unknown }).orderbook;
});

describe('Office notice board: reading and the badge', () => {
  it('counts the unread notices on the sidebar row and drops the count on Mark as read', async () => {
    const calls = await boot({
      permissions: ['notices.view'],
      notices: [notice('n1'), notice('n2'), notice('n3', { readByMe: true })],
    });
    await waitFor(async () => expect(await badge()).toBe('2'));

    await openBoard();
    fireEvent.click(screen.getAllByRole('button', { name: t('notices.board.markRead') })[0]!);

    await waitFor(() => expect(readCalls(calls)).toHaveLength(1));
    expect(readCalls(calls)[0]!.body).toEqual({ ids: [expect.stringMatching(/^n[12]$/)] });
    await waitFor(async () => expect(await badge()).toBe('1'));
  });

  it('marks every unread notice, by id, with Mark all as read', async () => {
    const calls = await boot({
      permissions: ['notices.view'],
      notices: [notice('n1'), notice('n2'), notice('n3', { readByMe: true })],
    });
    await openBoard();
    fireEvent.click(screen.getByRole('button', { name: t('notices.board.markAllRead') }));

    await waitFor(() => expect(readCalls(calls)).toHaveLength(1));
    const { ids } = readCalls(calls)[0]!.body as { ids: string[] };
    expect([...ids].sort()).toEqual(['n1', 'n2']);
    await waitFor(async () => expect(await badge()).toBeNull());
  });
});

describe('Office notice board: offline reads', () => {
  it('keeps a read made offline and sends it when the link comes back', async () => {
    const calls = await boot({
      permissions: ['notices.view'],
      notices: [notice('n1'), notice('n2')],
      connection: { state: 'disconnected' },
    });
    await openBoard();
    fireEvent.click(screen.getByRole('button', { name: t('notices.board.markAllRead') }));

    await waitFor(async () => expect(await badge()).toBeNull());
    expect(readCalls(calls)).toHaveLength(0);
    expect(JSON.parse(localStorage.getItem('orderbook.noticeReads.user-1') ?? '[]')).toHaveLength(
      2,
    );

    await act(async () => {
      FakeEventSource.instances.at(-1)!.emit('status', { state: 'connected' });
    });
    await waitFor(() => expect(readCalls(calls)).toHaveLength(1));
    expect((readCalls(calls)[0]!.body as { ids: string[] }).ids.sort()).toEqual(['n1', 'n2']);
    await waitFor(() => expect(localStorage.getItem('orderbook.noticeReads.user-1')).toBeNull());
  });

  // D10's D9-1: the replay ran once on 'connected', was refused, and never ran again while the
  // link stayed up. Now it backs off and tries again, with nobody pressing anything.
  it.each([
    ['the Master is out of reach', 503, 'unavailable'],
    ['the Master is not ready for the command yet', 426, 'updateNeeded'],
  ])('sends a read again on its own after a refusal because %s', async (_why, status, code) => {
    let refused = false;
    const calls = await boot({
      permissions: ['notices.view'],
      notices: [notice('n1')],
      route: (call) => {
        if (call.url !== '/api/notices/read' || refused) return undefined;
        refused = true;
        return json({ error: code, message: 'not now' }, status);
      },
    });
    await openBoard();
    fireEvent.click(screen.getByRole('button', { name: t('notices.board.markRead') }));
    await waitFor(() => expect(readCalls(calls)).toHaveLength(1));
    expect(JSON.parse(localStorage.getItem('orderbook.noticeReads.user-1') ?? '[]')).toEqual([
      'n1',
    ]);

    await waitFor(() => expect(readCalls(calls)).toHaveLength(2), { timeout: 4000 });
    expect(readCalls(calls)[1]!.body).toEqual({ ids: ['n1'] });
    await waitFor(() => expect(localStorage.getItem('orderbook.noticeReads.user-1')).toBeNull());
  });

  it('sends the queue again when a fresh snapshot arrives, without waiting out the backoff', async () => {
    let refused = false;
    const calls = await boot({
      permissions: ['notices.view'],
      notices: [notice('n1')],
      route: (call) => {
        if (call.url !== '/api/notices/read' || refused) return undefined;
        refused = true;
        return json({ error: 'unavailable', message: 'down' }, 503);
      },
    });
    await openBoard();
    fireEvent.click(screen.getByRole('button', { name: t('notices.board.markRead') }));
    await waitFor(() => expect(readCalls(calls)).toHaveLength(1));

    await act(async () => {
      FakeEventSource.instances.at(-1)!.emit('snapshot', snapshot([notice('n1')]));
    });
    // Well inside the first one-second backoff.
    await waitFor(() => expect(readCalls(calls)).toHaveLength(2), { timeout: 500 });
  });

  it('keeps a read refused with sign_in_again for its person, and sends it when they sign in', async () => {
    const calls = await boot({
      permissions: ['notices.view'],
      notices: [notice('n1')],
      route: (call) =>
        call.url === '/api/notices/read'
          ? json({ error: 'sign_in_again', message: 'Sign in again' }, 401)
          : undefined,
    });
    await openBoard();
    fireEvent.click(screen.getByRole('button', { name: t('notices.board.markRead') }));
    await waitFor(() => expect(readCalls(calls)).toHaveLength(1));
    expect(JSON.parse(localStorage.getItem('orderbook.noticeReads.user-1') ?? '[]')).toEqual([
      'n1',
    ]);

    // The same person, signed in again at this window.
    cleanup();
    FakeEventSource.instances.length = 0;
    const again = await boot({ permissions: ['notices.view'], notices: [notice('n1')] });
    await waitFor(() => expect(readCalls(again)).toHaveLength(1));
    expect(readCalls(again)[0]!.body).toEqual({ ids: ['n1'] });
    await waitFor(() => expect(localStorage.getItem('orderbook.noticeReads.user-1')).toBeNull());
  });

  it('drops a queued read refused for good (no notices.view)', async () => {
    const calls = await boot({
      permissions: ['notices.view'],
      notices: [notice('n1')],
      route: (call) =>
        call.url === '/api/notices/read'
          ? json({ error: 'forbidden', message: 'no' }, 403)
          : undefined,
    });
    await openBoard();
    fireEvent.click(screen.getByRole('button', { name: t('notices.board.markRead') }));
    await waitFor(() => expect(readCalls(calls)).toHaveLength(1));
    await waitFor(() => expect(localStorage.getItem('orderbook.noticeReads.user-1')).toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(readCalls(calls)).toHaveLength(1);
  });

  it('never sends or counts a read another person queued at this window', async () => {
    // Somebody else read n1 offline here and signed out before the link came back.
    localStorage.setItem('orderbook.noticeReads.user-other', JSON.stringify(['n1']));
    const calls = await boot({ permissions: ['notices.view'], notices: [notice('n1')] });

    await waitFor(async () => expect(await badge()).toBe('1'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(readCalls(calls)).toHaveLength(0);
    expect(localStorage.getItem('orderbook.noticeReads.user-other')).toBe('["n1"]');
  });
});

describe('Office notice board: management and the Dashboard', () => {
  it('lists every notice for a manager and creates one through the panel', async () => {
    const managed = [notice('m1', { readCount: 1, audienceSize: 3, expired: false })];
    const calls = await boot({
      permissions: ['notices.view', 'notices.manage'],
      notices: [],
      route: (call) => {
        if (call.url === '/api/notices/manage') return json(managed);
        if (call.url === '/api/notices/audiences') return json([{ id: 'r1', name: 'Sales' }]);
        if (call.url === '/api/notices' && call.method === 'POST') {
          return json(notice('m2'));
        }
        return undefined;
      },
    });
    fireEvent.click(await screen.findByTitle(t('nav.noticesManage')));
    await screen.findByText('Notice m1');

    fireEvent.click(screen.getAllByRole('button', { name: t('notices.manage.new') })[0]!);
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(
      within(dialog).getByLabelText(new RegExp(`^${t('notices.editor.titleLabel')}`)),
      {
        target: { value: 'Holiday on Friday' },
      },
    );
    fireEvent.change(
      within(dialog).getByLabelText(new RegExp(`^${t('notices.editor.bodyLabel')}`)),
      {
        target: { value: 'The office is closed.' },
      },
    );
    fireEvent.click(within(dialog).getByRole('button', { name: t('notices.editor.save') }));

    await waitFor(() =>
      expect(calls.some((call) => call.url === '/api/notices' && call.method === 'POST')).toBe(
        true,
      ),
    );
    const created = calls.find((call) => call.url === '/api/notices' && call.method === 'POST')!;
    expect(created.body).toMatchObject({
      title: 'Holiday on Friday',
      body: 'The office is closed.',
    });
    // The list is read again after the write.
    await waitFor(() =>
      expect(calls.filter((call) => call.url === '/api/notices/manage').length).toBeGreaterThan(1),
    );
  });

  // With no leads or orders the Dashboard is its empty state; the card was left out of it.
  it('shows an important notice on the Dashboard, before any order exists, and opens the board from it', async () => {
    await boot({
      permissions: ['notices.view', 'leads.view'],
      notices: [notice('n1', { priority: 'important', title: 'Stock count Saturday' })],
    });
    fireEvent.click(await screen.findByTitle(t('nav.dashboard')));
    await screen.findByText('Stock count Saturday');
    fireEvent.click(screen.getByRole('button', { name: t('notices.card.open') }));
    await screen.findByRole('button', { name: t('notices.board.markRead') });
  });

  // Owner add-on V5: the slideshow, from this person's cache, opening the notice it shows.
  it('turns over every notice placed on Basic Home, pinned first, and opens the one pressed', async () => {
    await boot({
      permissions: ['notices.view', 'leads.view'],
      roleTier: 'office',
      notices: [
        notice('n1', { pinned: true, title: 'Pinned rule' }),
        notice('n2', { title: 'Plain chatter' }),
        notice('n3', { title: 'Sign-in only', showOnHome: false }),
      ],
    });
    const band = await screen.findByRole('region', { name: t('notices.slideshow.label') });
    expect(within(band).getByText('Pinned rule')).toBeTruthy();
    // Two slides: the ordinary notice is one of them (2026-10-08), the sign-in-only one is not.
    expect(within(band).getAllByRole('button', { name: /^Show notice/ })).toHaveLength(2);
    fireEvent.click(within(band).getByText('Pinned rule'));
    await screen.findByRole('button', { name: t('notices.board.markAllRead') });
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('data-notice')).toBe('n1'),
    );
  });

  it('shows an ordinary, unpinned notice on Basic Home', async () => {
    await boot({
      permissions: ['notices.view', 'leads.view'],
      roleTier: 'office',
      notices: [notice('n2', { title: 'Plain chatter' })],
    });
    const band = await screen.findByRole('region', { name: t('notices.slideshow.label') });
    expect(within(band).getByText('Plain chatter')).toBeTruthy();
  });

  it('says there are no notices on Basic Home when there are none, and opens the board from there', async () => {
    await boot({
      permissions: ['notices.view', 'leads.view'],
      roleTier: 'office',
      notices: [notice('n1', { title: 'Sign-in only', showOnHome: false })],
    });
    const band = await screen.findByRole('region', { name: t('notices.slideshow.label') });
    expect(within(band).getByText(t('notices.board.emptyTitle'))).toBeTruthy();
    fireEvent.click(within(band).getByRole('button', { name: t('notices.card.open') }));
    await screen.findByRole('button', { name: t('notices.board.markAllRead') });
  });

  it('shows no band on Basic Home when the company turned it off', async () => {
    await boot({
      permissions: ['notices.view', 'leads.view'],
      roleTier: 'office',
      notices: [notice('n2', { title: 'Plain chatter' })],
      features: { noticesOnHome: false, noticesAtSignIn: false },
    });
    await screen.findByTitle(t('nav.notices'));
    expect(screen.queryByRole('region', { name: t('notices.slideshow.label') })).toBeNull();
    // The board itself is still there.
    fireEvent.click(screen.getByTitle(t('nav.notices')));
    expect(await screen.findByText('Plain chatter')).toBeTruthy();
  });

  it('drops the band when the switch is turned off on the Master: a setting change brings a fresh snapshot', async () => {
    await boot({
      permissions: ['notices.view', 'leads.view'],
      roleTier: 'office',
      notices: [notice('n2', { title: 'Plain chatter' })],
    });
    await screen.findByRole('region', { name: t('notices.slideshow.label') });

    // `setting` is snapshot-forcing (`SNAPSHOT_FORCING_ENTITIES`): what arrives next is this.
    await act(async () => {
      FakeEventSource.instances
        .at(-1)!
        .emit('snapshot', snapshot([notice('n2', { title: 'Plain chatter' })], { noticesOnHome: false }));
    });
    expect(screen.queryByRole('region', { name: t('notices.slideshow.label') })).toBeNull();
  });

  it('shows no notices to somebody without notices.view, even if the snapshot carried some', async () => {
    await boot({ permissions: ['leads.view'], notices: [notice('n1', { priority: 'important' })] });
    await screen.findByTitle(t('nav.leads'));
    expect(screen.queryByTitle(t('nav.notices'))).toBeNull();
    expect(screen.queryByText('Notice n1')).toBeNull();
  });
});

describe('Office "Sell today" and the Basic Home product band (2026-10-08)', () => {
  const DAMRU = {
    id: 'prod-9', tenantId: 'tenant-1', name: 'DAMRU', alias: null, categoryId: 'cat-1', categoryName: 'Table Top Basin',
    categoryCode: 'TTB', brand: 'Swisware+', sortOrder: 1, size: '600 x 400', hasVariants: false, multiColour: false,
    variants: [{ id: 'var-9', productId: 'prod-9', label: null, code: 'TTB-0009', weightKg: null, sequence: 0, isActive: true }],
    customFields: {}, isActive: true, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    sync: { version: 1, hlc: '', fieldHlc: {} },
    images: [{ id: 'img-9', productId: 'prod-9', caption: null, isPrimary: true, sequence: 0, width: 800, height: 800, checksum: 'x', blurhash: '', byteSize: 1, uploadedAt: '2026-10-01T00:00:00.000Z' }],
  };
  const ENTRY = {
    id: 'ST1', tenantId: 'tenant-1', title: 'Push the Damru range', body: '', productIds: ['prod-9'],
    products: [{ id: 'prod-9', name: 'DAMRU', code: 'TTB-0009', size: '600 x 400', mainProduct: 'Table Top Basin', image: null }],
    autoCloseSeconds: 0, showFrom: null, showUntil: null, audience: { kind: 'all' }, authorId: null, authorName: null,
    createdAt: '2026-10-08T08:00:00.000Z', updatedAt: '2026-10-08T08:00:00.000Z', version: 1,
  };
  const sellPopup = () => screen.queryByRole('dialog', { name: 'Push the Damru range' });
  const noticePopup = () => screen.queryByRole('dialog', { name: t('notices.signIn.title') });

  beforeEach(() => window.localStorage.clear());

  it('pops up from the snapshot after the unread notices, offline too, and not twice', async () => {
    await boot({
      permissions: ['notices.view', 'products.view'],
      notices: [notice('n1', { priority: 'important' })],
      connection: { state: 'disconnected' },
      features: {},
      extra: { sellToday: [ENTRY] },
    });
    await waitFor(() => expect(noticePopup()).not.toBeNull());
    expect(sellPopup()).toBeNull();

    fireEvent.click(within(noticePopup()!).getByRole('button', { name: t('notices.signIn.later') }));
    await waitFor(() => expect(sellPopup()).not.toBeNull());
    // Set to stay until closed: no countdown.
    expect(screen.queryByRole('timer')).toBeNull();
    fireEvent.click(within(sellPopup()!).getByRole('button', { name: t('sellToday.popup.start') }));

    await act(async () => {
      FakeEventSource.instances.at(-1)!.emit('snapshot', snapshot([], {}, { sellToday: [ENTRY] }));
    });
    expect(sellPopup()).toBeNull();
  });

  it('never pops up when the company turned it off', async () => {
    await boot({
      permissions: ['notices.view'],
      notices: [],
      features: { sellTodayPopup: false },
      extra: { sellToday: [ENTRY] },
    });
    await screen.findByTitle(t('nav.notices'));
    expect(sellPopup()).toBeNull();
  });

  it('fills the product band with the day’s products, opening one in the catalogue', async () => {
    await boot({
      permissions: ['notices.view', 'products.view', 'leads.view'],
      roleTier: 'office',
      notices: [],
      features: { noticesAtSignIn: false, sellTodayPopup: false },
      extra: { sellToday: [ENTRY], products: [DAMRU] },
    });
    const band = await screen.findByRole('region', { name: t('productShow.sellToday') });
    expect(band.closest('.ob-home-bands')?.querySelector('.ob-slideshow')).not.toBeNull();

    fireEvent.click(within(band).getByTitle(t('productShow.open', { name: 'DAMRU' })));
    expect(await screen.findByRole('button', { name: t('action.backToList') })).toBeTruthy();
  });

  it('features the snapshot’s sub products with photos without an entry, and follows its switch', async () => {
    await boot({
      permissions: ['notices.view', 'products.view', 'leads.view'],
      roleTier: 'office',
      notices: [],
      extra: { products: [DAMRU, { ...DAMRU, id: 'prod-10', name: 'NO PHOTO', images: [] }] },
    });
    const band = await screen.findByRole('region', { name: t('productShow.label') });
    expect(within(band).getByText('DAMRU')).toBeTruthy();
    expect(within(band).queryByText('NO PHOTO')).toBeNull();

    await act(async () => {
      FakeEventSource.instances
        .at(-1)!
        .emit('snapshot', snapshot([], { productSlideshow: false }, { products: [DAMRU] }));
    });
    expect(screen.queryByRole('region', { name: t('productShow.label') })).toBeNull();
  });
});
