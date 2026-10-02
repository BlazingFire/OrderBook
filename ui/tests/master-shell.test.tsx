/**
 * The Master Panel's shell, booted whole in jsdom (`panel-harness.ts` says
 * how; the live socket is the one extra edge replaced here). What it pins:
 *
 *  · the footer's "Design system" link keeps the gallery open;
 *  · Alt+N reaches only what the sidebar offers — with the desktop menu's
 *    Developer entry still opening Settings for anybody, as it always has;
 *  · the screen somebody was on does not outlive their session: whoever signs
 *    in next at that window starts on their own landing screen (the Dashboard
 *    for an Admin, Basic Home for Office and Management), not on a screen the
 *    sidebar does not offer them;
 *  · Basic Home offers a tile for each module the sidebar offers, the brand
 *    mark goes to the landing screen, and the footer names the company;
 *  · a Master whose server cannot be reached says so on the splash, rather
 *    than "Request cancelled" in English;
 *  · a change another administrator makes reaches the screens built from it:
 *    people and roles on Roles & users, a catalogue import on Pending Orders,
 *    a field value or definition in the Recycle Bin, and a
 *    stage edit in the stage pages and chips;
 *  · Pending Orders and Final Orders are modules of their own, each gated on its
 *    permission, whose rows open as sub-screens with a way back, and whose
 *    actions (Convert, Dispatch) are absent without theirs;
 *  · New pending order: the topbar button and sub-page only with `leads.create`,
 *    Ctrl+Shift+N opens the form (not the Dashboard), a draft survives leaving
 *    and coming back, Save posts and returns to the list, Reset asks first, and
 *    Edit pending order is offered with `leads.edit`;
 *  · a role edit reaches an open window: the permissions are re-read, and a tab
 *    the role no longer offers gives way to the Dashboard;
 *  · the Dashboard draws a card only for a figure the server sent, and reads no
 *    leads without `leads.view`; a follow-up row opens that lead;
 *  · a party opens as a sub-screen that reads its own records (also from a
 *    search hit), a password change
 *    lands on sign-in with its notice, and Settings reaches Appearance for
 *    anyone without reading what only a manager may.
 */

import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { t } from '../src/i18n.js';
import { publishSessionEnded } from '../src/sessionEnded.js';
import {
  installBrowserStubs,
  json,
  loadApp,
  pressAltDigit,
  pressAltDigitUntil,
  routeFetch,
  topbarTitle,
  wait,
  type Call,
} from './panel-harness.js';

const { sockets } = vi.hoisted(() => {
  /** The browser end of the Master's Socket.IO link, with a way to push events down it. */
  class FakeSocket {
    closed = false;
    private readonly handlers = new Map<string, Array<(payload: unknown) => void>>();

    on(event: string, handler: (payload: unknown) => void): this {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
      return this;
    }

    close(): void {
      this.closed = true;
    }

    emit(event: string, payload: unknown): void {
      for (const handler of this.handlers.get(event) ?? []) handler(payload);
    }
  }

  return { sockets: { FakeSocket, all: [] as FakeSocket[] } };
});

vi.mock('socket.io-client', () => ({
  io: () => {
    const socket = new sockets.FakeSocket();
    sockets.all.push(socket);
    return socket;
  },
}));

const PICK_PARTY = { id: 'party-1', partyCode: 'P-001', name: 'Sharma Traders', city: 'Morbi', phone: null };
const PICK_CATEGORY = { id: 'cat-1', name: 'ONE PIECE TOILET', code: 'OPT', brand: 'Swisware+', sortOrder: 1 };
const PICK_PRODUCT = {
  id: 'prod-1', name: 'Aqua Closet', categoryId: 'cat-1', categoryName: 'ONE PIECE TOILET',
  categoryCode: 'OPT', brand: 'Swisware+', sortOrder: 1, alias: null, size: 'L-27',
  multiColour: false, hasVariants: true,
  variants: [{ id: 'var-1', label: 'White', code: 'OPT-0001', weightKg: 30, isActive: true }],
};

const ADMIN = [
  'leads.view',
  'orders.view',
  'products.view',
  'roles.view',
  'users.manage',
  'recycleBin.view',
  'leads.delete',
  'fields.manage',
  'panels.manage',
  'settings.manage',
];

function user(permissions: string[], roleTier = 'admin') {
  return {
    id: 'user-1',
    tenantId: 'tenant-1',
    username: 'owner',
    displayName: 'Owner',
    roleId: 'role-1',
    roleName: 'Administrator',
    roleTier,
    isActive: true,
    avatar: null,
    permissions,
    roleVersion: 1,
    features: {},
  };
}

async function boot(
  permissions: string[],
  /** Asked first; `undefined` falls through to the answers below. */
  route?: (call: Call) => Response | undefined,
): Promise<Call[]> {
  const calls = routeFetch((call) => {
    const answer = route?.(call);
    if (answer) return answer;
    const { url } = call;
    const path = url.split('?')[0] ?? url;
    if (path === '/api/setup/status') return json({ setupComplete: true });
    if (path === '/api/auth/me') {
      return json({ user: user(permissions), sessionToken: 'session-1', defaultLocale: 'en' });
    }
    if (path === '/api/access/users' || path === '/api/access/roles') return json([]);
    if (path === '/api/access/permission-catalogue') {
      return json({ modules: [], capabilities: [], tiers: [] });
    }
    if (path === '/api/pipelines') return json([]);
    // The Products module: its categories, and the catalogue page it lists from.
    if (path === '/api/categories') return json([]);
    if (path === '/api/products') return json({ items: [], total: 0, limit: 100, offset: 0 });
    if (path === '/api/option-lists') return json([]);
    // The New / Edit pending order form: its view, and its three pickers.
    if (path === '/api/lead-entry') {
      return json({ optionLists: [], partyVariants: [], stock: [], partyGrants: [], features: {} });
    }
    if (path === '/api/pick/party') return json({ items: [PICK_PARTY], truncated: false });
    if (path === '/api/pick/category') return json({ items: [PICK_CATEGORY], truncated: false });
    if (path === '/api/pick/product') return json({ items: [PICK_PRODUCT], truncated: false });
    if (path === '/api/leads' || path === '/api/orders') {
      return json({ items: [], total: 0, limit: 100, offset: 0 });
    }
    if (path === '/api/recycle-bin') return json({ items: [], nextCursor: null });
    if (path === '/api/recycle-bin/counts') return json({});
    if (path === '/api/recycle-bin/deleters') return json([]);
    return undefined;
  });

  const App = await loadApp('master');
  render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  await screen.findByRole('link', { name: t('footer.designSystem') });
  return calls;
}

/**
 * Another administrator's write, as the Master's hub broadcasts it.
 *
 * Waits for the link first. The panel opens it in an effect, which React may
 * not have run by the time the shell is on screen; an event sent before then
 * reached nobody, and a test that expects no refetch passed without a change
 * ever having arrived.
 */
async function changed(entity: string): Promise<void> {
  const live = () => sockets.all.filter((socket) => !socket.closed).at(-1);
  await waitFor(() => expect(live()).toBeDefined());
  await act(async () => {
    live()!.emit('data:changed', { entity, action: 'updated', id: 'x', payload: null });
    await wait(0);
  });
}

async function open(label: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTitle(label));
    await wait(0);
  });
}

const gets = (calls: Call[], path: string) =>
  calls.filter((call) => call.method === 'GET' && call.url.split('?')[0] === path).length;

beforeEach(() => {
  installBrowserStubs();
  sockets.all = [];
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as { orderbook?: unknown }).orderbook;
});

describe('the design-system gallery', () => {
  it('stays open after the link it was opened from changes the hash', async () => {
    await boot(ADMIN);

    await act(async () => {
      fireEvent.click(screen.getByRole('link', { name: t('footer.designSystem') }));
      window.location.hash = '#/gallery';
      await wait(0);
    });

    expect(topbarTitle()).toBe(t('footer.designSystem'));
  });

  it('opens when the panel is loaded at #/gallery', async () => {
    window.history.replaceState(null, '', '/#/gallery');
    await boot(ADMIN);

    expect(topbarTitle()).toBe(t('footer.designSystem'));
  });
});

describe('Alt+N', () => {
  it('does not open a screen the sidebar does not offer', async () => {
    // Alt+4 is Final Orders, which needs `orders.view`: the Master's Alt+N follow
    // the chord map both panels share (`shared/tests/keys-nav-order.test.ts`).
    // The topbar names the sub-page showing, which for Pending Orders is its List.
    await boot(['leads.view']);
    await pressAltDigitUntil(3, t('lead.board.tab.list'));

    await act(async () => pressAltDigit(4));

    expect(topbarTitle()).toBe(t('lead.board.tab.list'));
  });

  it('opens Final Orders on its first page, All stages', async () => {
    await boot(['orders.view']);

    await pressAltDigitUntil(4, t('orders.filter.allStages'));
  });

  it('opens a screen the sidebar does offer', async () => {
    // Alt+9 is Settings, loaded on first visit; the topbar names its tab. The
    // Admin screens have no digit since 1.3, and the palette reaches them.
    await boot(ADMIN);

    await pressAltDigitUntil(9, t('settings.tab.company'));
  });

  it('opens Products on its first page, Sub products', async () => {
    // The topbar names the sub-page showing, not the module: `nav.products` and
    // `catalog.nav.mainProducts` are both "Products".
    await boot(ADMIN);

    await pressAltDigitUntil(6, t('catalog.nav.subProducts'));
  });
});

describe('the next person to sign in at this window', () => {
  /** Signs in through the real form as somebody holding only `leads.view`. */
  async function signInAsSales(): Promise<void> {
    fireEvent.change(await screen.findByLabelText(t('signIn.field.username')), {
      target: { value: 'ravi' },
    });
    fireEvent.change(screen.getByLabelText(t('signIn.field.password')), {
      target: { value: 'secret' },
    });
    await act(async () => {
      fireEvent.submit(screen.getByLabelText(t('signIn.field.password')).closest('form')!);
      await wait(0);
    });
  }

  const answers = ({ method, url }: Call) => {
    if (url === '/api/auth/sign-out' && method === 'POST')
      return new Response(null, { status: 204 });
    if (url === '/api/auth/sign-in' && method === 'POST') {
      return json({ user: user(['leads.view']), sessionToken: 'session-2' });
    }
    return undefined;
  };

  it('starts on the Dashboard, not on the screen the last one signed out from', async () => {
    await boot(ADMIN, answers);
    await open(t('nav.master.panels'));
    expect(topbarTitle()).toBe(t('nav.master.panels'));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('action.signOut') }));
      await wait(0);
    });
    await signInAsSales();

    // Office panels needs `panels.manage`: its sidebar entry is gone, and the
    // screen went on being drawn under a title that named nothing.
    expect(topbarTitle()).toBe(t('nav.master.dashboard'));
  });

  it('starts an Office user on Basic Home', async () => {
    await boot(ADMIN, (call) =>
      call.url === '/api/auth/sign-in' && call.method === 'POST'
        ? json({ user: user(['leads.view'], 'office'), sessionToken: 'session-2' })
        : answers(call),
    );
    await open(t('nav.master.panels'));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('action.signOut') }));
      await wait(0);
    });
    await signInAsSales();

    expect(topbarTitle()).toBe(t('nav.basicHome'));
  });

  it('does not show the last person open record in the sidebar', async () => {
    await openList(ADMIN, t('nav.leads'), answers);
    fireEvent.click(await screen.findByText(LEAD.id));
    await screen.findByRole('button', { name: t('action.backToList') });
    expect(screen.getAllByTitle(LEAD.partyName).length).toBeGreaterThan(0);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('action.signOut') }));
      await wait(0);
    });
    await signInAsSales();

    expect(screen.queryAllByTitle(LEAD.partyName)).toHaveLength(0);
  });

  it('starts on the Dashboard after a session the server ended', async () => {
    await boot(ADMIN, answers);
    await open(t('nav.master.panels'));

    // Somebody changed this person's password, say, from another window.
    await act(async () => {
      publishSessionEnded('signIn.notice.sessionEnded');
    });
    await signInAsSales();

    expect(topbarTitle()).toBe(t('nav.master.dashboard'));
  });
});

describe('Basic Home and the landing screen', () => {
  const MANAGER = ['leads.view', 'leads.create', 'products.view'];

  /** Boots as somebody whose role has the given tier. */
  function bootAs(tier: string, permissions: string[]): Promise<Call[]> {
    return boot(permissions, ({ url }) =>
      url === '/api/auth/me'
        ? json({ user: user(permissions, tier), sessionToken: 'session-1', defaultLocale: 'en' })
        : undefined,
    );
  }

  const launcher = () => document.querySelector<HTMLElement>('.ob-launcher')!;

  it('lands an Admin on the Dashboard', async () => {
    await boot(ADMIN);

    expect(topbarTitle()).toBe(t('nav.master.dashboard'));
  });

  it('lands Management on Basic Home, with a tile for each module the sidebar offers', async () => {
    await bootAs('management', MANAGER);

    expect(topbarTitle()).toBe(t('nav.basicHome'));
    const tiles = [...launcher().querySelectorAll('.ob-tile-label')].map((tile) => tile.textContent);
    // Not Basic Home itself, and nothing the role cannot open (Final Orders,
    // Office panels): absent, not greyed.
    expect(tiles).toEqual([
      t('basicHome.newLead'),
      t('nav.master.dashboard'),
      t('nav.leads'),
      t('nav.products'),
      t('nav.master.settings'),
      t('nav.updates'),
    ]);
  });

  it('opens a module from its tile, and the brand mark comes back to Basic Home', async () => {
    await bootAs('management', MANAGER);

    await act(async () => {
      fireEvent.click(within(launcher()).getByRole('button', { name: t('nav.leads') }));
      await wait(0);
    });
    expect(topbarTitle()).toBe(t('lead.board.tab.list'));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('nav.home') }));
      await wait(0);
    });
    expect(topbarTitle()).toBe(t('nav.basicHome'));
  });

  it('opens the New pending order form from its tile', async () => {
    await bootAs('office', MANAGER);

    await act(async () => {
      fireEvent.click(within(launcher()).getByRole('button', { name: t('basicHome.newLead') }));
      await wait(0);
    });

    expect(await screen.findByLabelText(t('lead.add.party.search'))).toBeTruthy();
  });

  it('names the company in the footer, from the setup status', async () => {
    await boot(['leads.view'], ({ url }) =>
      url === '/api/setup/status'
        ? json({ setupComplete: true, companyName: 'Shree Ceramics' })
        : undefined,
    );

    expect(screen.getByText(`${t('footer.company')} · Shree Ceramics`)).toBeTruthy();
  });
});

describe('the splash', () => {
  it('says the server could not be reached when the request never got there', async () => {
    routeFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    const App = await loadApp('master');
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );

    expect(await screen.findByText(t('splash.error.unreachable'))).toBeTruthy();
  });
});

describe('a change made elsewhere reaches the screen built from it', () => {
  it('Roles & users refetches the people when one changes', async () => {
    const calls = await boot(ADMIN);
    await open(t('nav.master.access'));
    // Roles & users loads on first visit, so its first read comes a moment later.
    await waitFor(() => expect(gets(calls, '/api/access/users')).toBeGreaterThan(0));
    const before = gets(calls, '/api/access/users');

    await changed('user');

    expect(gets(calls, '/api/access/users')).toBeGreaterThan(before);
  });

  it('Roles & users refetches the roles when one changes', async () => {
    const calls = await boot(ADMIN);
    await open(t('nav.master.access'));
    await waitFor(() => expect(gets(calls, '/api/access/roles')).toBeGreaterThan(0));
    const before = gets(calls, '/api/access/roles');

    await changed('role');

    expect(gets(calls, '/api/access/roles')).toBeGreaterThan(before);
  });

  it('Pending Orders refetches after a catalogue import', async () => {
    const calls = await boot(ADMIN);
    await open(t('nav.leads'));
    const before = gets(calls, '/api/leads');
    expect(before).toBeGreaterThan(0);

    await changed('catalog');

    expect(gets(calls, '/api/leads')).toBeGreaterThan(before);
  });

  it('the shell re-reads the stages when a pipeline changes', async () => {
    const calls = await boot(ADMIN);
    await open(t('nav.leads'));
    const before = gets(calls, '/api/pipelines');
    expect(before).toBeGreaterThan(0);

    await changed('pipeline');

    expect(gets(calls, '/api/pipelines')).toBeGreaterThan(before);
  });

  it.each(['option_list', 'custom_field'])(
    'the Recycle Bin refetches when a %s row is deleted or restored',
    async (entity) => {
      const calls = await boot(ADMIN);
      await open(t('nav.master.recycleBin'));
      await waitFor(() => expect(gets(calls, '/api/recycle-bin')).toBeGreaterThan(0));
      const before = gets(calls, '/api/recycle-bin');

      await changed(entity);

      expect(gets(calls, '/api/recycle-bin')).toBeGreaterThan(before);
    },
  );
});

const LEAD = {
  id: 'LD0000000001', partyId: 'party-1', partyName: 'Shree Ceramics', stageId: 'stage-l1',
  stageName: 'New', convertedOrderId: null, incomplete: false, missingFields: [],
  sourcePlatform: null, followUpDate: null, partyWiseMode: false, notes: null,
  createdAt: '2026-09-30T10:00:00.000Z', totalWeightKg: 24, linesWithoutWeight: 0,
  timeline: [], sync: { hlc: 'h1' },
  items: [{
    id: 'l1', productName: 'Rustic Wood', categoryName: 'Duragres', code: 'RW1', size: '600x600',
    brandName: null, variantLabel: 'Ivory', colour: null, grade: null, packaging: 'Box',
    quantity: 12, weightKg: 2, lineWeightKg: 24,
  }],
};

const ORDER = {
  id: 'OD0000000001', partyId: 'party-1', partyName: 'Shree Ceramics', leadId: null,
  stageId: 'stage-1', stageName: 'Confirmed', dispatchedAt: null, totalWeightKg: 24,
  totalWeightKgOverride: null, weightSource: 'computed', vehicleNumber: null,
  linesWithoutWeight: 0, reservations: [], timeline: [],
  items: [{
    id: 'l1', variantId: 'v1', productName: 'Rustic Wood', categoryName: 'Duragres',
    size: '600x600', brandName: null, variantLabel: 'Ivory', colour: null, grade: null,
    packaging: 'Box', quantity: 12, weightKg: 2, lineWeightKg: 24,
  }],
};

/** Boots with one lead, one order and their party answering, then opens `label`. */
async function openList(
  permissions: string[],
  label: string,
  extra?: (call: Call) => Response | undefined,
): Promise<Call[]> {
  const calls = await boot(permissions, (call) => {
    const path = call.url.split('?')[0];
    // The Dashboard's follow-ups list stays mounted behind the module; empty, so
    // the lead is on screen once.
    if (path === '/api/leads' && call.url.includes('followUpDueOnly')) {
      return json({ items: [], total: 0, limit: 8, offset: 0 });
    }
    if (path === '/api/leads') return json({ items: [LEAD], total: 1, limit: 500, offset: 0 });
    if (path === '/api/orders') return json({ items: [ORDER], total: 1, limit: 500, offset: 0 });
    if (path === '/api/parties/party-1') {
      return json({ id: 'party-1', name: 'Shree Ceramics', partyCode: 'P-0001', city: 'Rajkot' });
    }
    return extra?.(call);
  });
  await open(label);
  return calls;
}

describe('Pending Orders and Final Orders', () => {
  it('open a row as a sub-screen with a way back and an entry in the sidebar', async () => {
    await openList(ADMIN, t('nav.leads'));

    fireEvent.click(await screen.findByText(LEAD.id));

    const back = await screen.findByRole('button', { name: t('action.backToList') });
    expect(screen.getAllByTitle(LEAD.partyName).length).toBeGreaterThan(0);

    fireEvent.click(back);
    expect(await screen.findByText(LEAD.id)).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('action.backToList') })).toBeNull();
  });

  it('are offered only with leads.view and orders.view', async () => {
    await boot(['leads.view']);
    expect(screen.queryByTitle(t('nav.orders'))).toBeNull();
    expect(screen.getByTitle(t('nav.leads'))).toBeTruthy();
  });

  it('offer Convert only with lead.convert', async () => {
    await openList(['leads.view'], t('nav.leads'));
    fireEvent.click(await screen.findByText(LEAD.id));
    await screen.findByRole('button', { name: t('action.backToList') });
    expect(screen.queryByRole('button', { name: t('lead.detail.convertAction') })).toBeNull();

    cleanup();
    await openList(['leads.view', 'lead.convert'], t('nav.leads'));
    fireEvent.click(await screen.findByText(LEAD.id));
    expect(await screen.findByRole('button', { name: t('lead.detail.convertAction') })).toBeTruthy();
  });

  it('offer Dispatch only with orders.dispatch', async () => {
    await openList(['orders.view'], t('nav.orders'));
    fireEvent.click(await screen.findByText(ORDER.id));
    await screen.findByRole('button', { name: t('action.backToList') });
    expect(screen.queryByRole('button', { name: t('orders.detail.dispatchButton') })).toBeNull();

    cleanup();
    await openList(['orders.view', 'orders.dispatch'], t('nav.orders'));
    fireEvent.click(await screen.findByText(ORDER.id));
    expect(await screen.findByRole('button', { name: t('orders.detail.dispatchButton') })).toBeTruthy();
  });

  it('open a search hit for an order the list has not loaded through GET /api/orders/:id', async () => {
    // jsdom has no scrollIntoView, which the palette calls on its active row.
    Element.prototype.scrollIntoView = vi.fn();
    const calls = await boot(ADMIN, (call) => {
      const path = call.url.split('?')[0];
      if (path === '/api/search') {
        return json([
          { kind: 'order_line', id: ORDER.id, title: 'Rustic Wood', subtitle: null, rank: 1 },
        ]);
      }
      if (path === `/api/orders/${ORDER.id}`) return json(ORDER);
      return undefined;
    });

    fireEvent.click(screen.getByRole('button', { name: t('keys.command.palette') }));
    fireEvent.change(await screen.findByLabelText(t('keys.palette.placeholder')), {
      target: { value: 'rustic' },
    });
    const hit = await screen.findByText('Rustic Wood');
    await act(async () => {
      fireEvent.click(hit);
      await wait(0);
    });

    expect(await screen.findByRole('button', { name: t('action.backToList') })).toBeTruthy();
    expect(calls.some((call) => call.url === `/api/orders/${ORDER.id}`)).toBe(true);
  });

  it('says so when a search hit belongs to a screen the role does not have', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    await boot(['leads.view'], (call) => {
      if (call.url.split('?')[0] === '/api/search') {
        return json([
          { kind: 'order_line', id: ORDER.id, title: 'Rustic Wood', subtitle: null, rank: 1 },
        ]);
      }
      return undefined;
    });

    fireEvent.click(screen.getByRole('button', { name: t('keys.command.palette') }));
    fireEvent.change(await screen.findByLabelText(t('keys.palette.placeholder')), {
      target: { value: 'rustic' },
    });
    const hit = await screen.findByText('Rustic Wood');
    await act(async () => {
      fireEvent.click(hit);
      await wait(0);
    });

    expect(await screen.findByText(t('nav.recordNotAvailable'))).toBeTruthy();
  });
});

describe('Conflicts', () => {
  it('is offered only with sync.resolveConflicts', async () => {
    await boot(['leads.view']);
    expect(screen.queryByTitle(t('nav.master.conflicts'))).toBeNull();

    cleanup();
    await boot(['leads.view', 'sync.resolveConflicts']);
    expect(screen.getByTitle(t('nav.master.conflicts'))).toBeTruthy();
  });
});

describe('a role edit reaches a window that has it open', () => {
  it('re-reads the permissions, and an open tab the role lost gives way to the Dashboard', async () => {
    let permissions = ADMIN;
    const calls = await boot(ADMIN, ({ url }) =>
      url === '/api/auth/me'
        ? json({ user: user(permissions), sessionToken: 'session-1', defaultLocale: 'en' })
        : undefined,
    );
    await open(t('nav.master.panels'));
    expect(topbarTitle()).toBe(t('nav.master.panels'));
    const before = calls.filter((call) => call.url === '/api/auth/me').length;

    permissions = ['leads.view'];
    await changed('role');

    await waitFor(() => expect(topbarTitle()).toBe(t('nav.master.dashboard')));
    expect(calls.filter((call) => call.url === '/api/auth/me').length).toBeGreaterThan(before);
  });
});

describe('the Filling and Dispatch notes on an order', () => {
  async function openOrders(permissions: string[]) {
    const calls = await openList(permissions, t('nav.orders'));
    fireEvent.click(await screen.findByText(ORDER.id));
    await screen.findByRole('button', { name: t('action.backToList') });
    return calls;
  }

  it('is offered only with orders.export', async () => {
    await openOrders([...ADMIN]);
    expect(screen.queryByRole('button', { name: t('orderNote.filling') })).toBeNull();
  });

  it('opens the Dispatch note with the party fetched for its header, and prints through the shell', async () => {
    const printPage = vi.fn().mockResolvedValue({ ok: true });
    (window as { orderbook?: unknown }).orderbook = { shellVersion: 't', applyUpdate: vi.fn(), printPage };
    const calls = await openOrders([...ADMIN, 'orders.export', 'parties.view']);

    fireEvent.click(await screen.findByRole('button', { name: t('orderNote.dispatch') }));

    expect((await screen.findAllByText(t('orderNote.page', { n: 1, total: 1 }))).length).toBeGreaterThan(0);
    expect(calls.some((call) => call.url === '/api/parties/party-1')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: t('orderNote.print') }));
    await waitFor(() => expect(printPage).toHaveBeenCalledWith({ deviceName: undefined }));

    // Back from the note lands on the order, and back from that on the list.
    fireEvent.click(screen.getByRole('button', { name: t('action.backToList') }));
    fireEvent.click(await screen.findByRole('button', { name: t('action.backToList') }));
    expect(await screen.findByText(ORDER.id)).toBeTruthy();
  });
});

describe('New pending order', () => {
  const CREATE = ['leads.view', 'leads.create', 'parties.view', 'products.view'];

  const topbar = () => document.querySelector<HTMLElement>('.ob-topbar')!;
  const newLeadButton = () => within(topbar()).queryByRole('button', { name: t('action.newLead') });

  /** Ctrl+Shift+N, the way `KeyboardProvider` reads it: by `code`, with both held. */
  async function pressCtrlShiftN(): Promise<void> {
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'N', code: 'KeyN', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
        }),
      );
      await wait(0);
    });
  }

  /** Presses the chord until the form it opens is on screen — the provider binds in an effect. */
  async function openFormByKey(): Promise<void> {
    await waitFor(async () => {
      await pressCtrlShiftN();
      expect(screen.getByLabelText(t('lead.add.party.search'))).toBeTruthy();
    });
  }

  const searchBox = () => screen.getByLabelText(t('lead.add.products.searchLabel'));

  /** Party, product, sub product, a quantity — then Shift+Q adds the card. */
  async function fillOneLine(): Promise<void> {
    fireEvent.change(screen.getByLabelText(t('lead.add.party.search')), { target: { value: 'Sha' } });
    fireEvent.click(await screen.findByRole('button', { name: /Sharma Traders/ }));
    fireEvent.focus(searchBox());
    fireEvent.mouseDown(await screen.findByRole('button', { name: /ONE PIECE TOILET/ }));
    fireEvent.mouseDown(await screen.findByRole('button', { name: /Aqua Closet/ }));
    const qty = await screen.findByLabelText(`${t('lead.add.draft.col.quantity')} — White`);
    fireEvent.change(qty, { target: { value: '5' } });
    await act(async () => {
      fireEvent.keyDown(qty, { key: 'Q', shiftKey: true });
      await wait(0);
    });
  }

  it('offers the topbar button and the sub-page only with leads.create', async () => {
    await boot(['leads.view']);
    expect(newLeadButton()).toBeNull();
    expect(screen.queryByTitle(t('lead.add.title'))).toBeNull();

    cleanup();
    await boot(CREATE);
    expect(newLeadButton()).toBeTruthy();
    await open(t('nav.leads'));
    expect(screen.getByTitle(t('lead.add.title'))).toBeTruthy();
  });

  it('opens the form from the button, not the Dashboard, and hides the button on it', async () => {
    await boot(CREATE);

    await act(async () => {
      fireEvent.click(newLeadButton()!);
      await wait(0);
    });

    expect(await screen.findByLabelText(t('lead.add.party.search'))).toBeTruthy();
    expect(topbarTitle()).toBe(t('lead.add.title'));
    expect(newLeadButton()).toBeNull();
  });

  it('opens the form on Ctrl+Shift+N, and the sub-page opens it too', async () => {
    await boot(CREATE);
    await openFormByKey();
    expect(topbarTitle()).toBe(t('lead.add.title'));

    await pressAltDigitUntil(3, t('lead.board.tab.list'));
    await act(async () => {
      fireEvent.click(screen.getByTitle(t('lead.add.title')));
      await wait(0);
    });
    expect(screen.getByLabelText(t('lead.add.party.search'))).toBeTruthy();
    expect(topbarTitle()).toBe(t('lead.add.title'));
  });

  it('does nothing on Ctrl+Shift+N without leads.create', async () => {
    await boot(['leads.view']);
    await pressAltDigitUntil(3, t('lead.board.tab.list'));

    await pressCtrlShiftN();

    expect(screen.queryByLabelText(t('lead.add.party.search'))).toBeNull();
    expect(topbarTitle()).toBe(t('lead.board.tab.list'));
  });

  it('keeps a half-typed draft across Alt+2 and back', async () => {
    await boot(CREATE);
    await openFormByKey();
    fireEvent.change(screen.getByLabelText(t('lead.add.details.notes')), {
      target: { value: 'ring back' },
    });

    await pressAltDigitUntil(2, t('nav.master.dashboard'));
    await openFormByKey();

    expect((screen.getByLabelText(t('lead.add.details.notes')) as HTMLTextAreaElement).value).toBe(
      'ring back',
    );
  });

  it('saves with a POST, says so, and lands back on the list', async () => {
    let body: Record<string, unknown> | null = null;
    const calls = await boot(CREATE, (call) => {
      const path = call.url.split('?')[0];
      if (path === '/api/leads' && call.method === 'POST') {
        body = call.body as Record<string, unknown>;
        return json({ ...LEAD, id: 'LD0000000002' }, 201);
      }
      if (path === '/api/leads' && call.url.includes('followUpDueOnly')) {
        return json({ items: [], total: 0, limit: 8, offset: 0 });
      }
      if (path === '/api/leads') return json({ items: [LEAD], total: 1, limit: 500, offset: 0 });
      return undefined;
    });
    await openFormByKey();
    await fillOneLine();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('lead.add.save') }));
      await wait(0);
    });

    expect(await screen.findByText(t('lead.add.savedOnline', { id: 'LD0000000002' }))).toBeTruthy();
    expect(calls.filter((call) => call.url === '/api/leads' && call.method === 'POST')).toHaveLength(1);
    expect(body).toMatchObject({
      partyId: 'party-1',
      items: [expect.objectContaining({ variantId: 'var-1', quantity: 5 })],
    });
    expect(topbarTitle()).toBe(t('lead.board.tab.list'));
    expect(await screen.findByText(LEAD.id)).toBeTruthy();
  });

  it('has one New pending order entry in the sidebar while the form is open', async () => {
    await boot(CREATE);
    await openFormByKey();
    expect(screen.getAllByTitle(t('lead.add.title'))).toHaveLength(1);
  });

  it('returns to the Pending list on Cancel, even after a record was open', async () => {
    await openList(CREATE, t('nav.leads'));
    fireEvent.click(await screen.findByText(LEAD.id));
    await screen.findByRole('button', { name: t('action.backToList') });

    await openFormByKey();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('action.cancel') }));
      await wait(0);
    });

    expect(await screen.findByText(LEAD.id)).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('action.backToList') })).toBeNull();
    expect(topbarTitle()).toBe(t('lead.board.tab.list'));
  });

  it('asks before Reset throws a draft away', async () => {
    await boot(CREATE);
    await openFormByKey();
    fireEvent.change(screen.getByLabelText(t('lead.add.details.notes')), {
      target: { value: 'ring back' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('screen.reset') }));
      await wait(0);
    });

    // The form's own guard asks; the draft is still there until the answer.
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect((screen.getByLabelText(t('lead.add.details.notes')) as HTMLTextAreaElement).value).toBe(
      'ring back',
    );
  });

  it('offers Edit pending order on a lead only with leads.edit', async () => {
    await openList(['leads.view'], t('nav.leads'));
    fireEvent.click(await screen.findByText(LEAD.id));
    await screen.findByRole('button', { name: t('action.backToList') });
    expect(screen.queryByRole('button', { name: t('lead.edit.action') })).toBeNull();

    cleanup();
    await openList(['leads.view', 'leads.edit'], t('nav.leads'));
    fireEvent.click(await screen.findByText(LEAD.id));
    expect(await screen.findByRole('button', { name: t('lead.edit.action') })).toBeTruthy();
  });
});

const PRODUCT = {
  id: 'prod-1', name: 'Aqua Closet', alias: null, categoryId: 'cat-1', categoryName: 'ONE PIECE TOILET',
  categoryCode: 'OPT', brand: 'Swisware+', sortOrder: 1, size: 'L-27', multiColour: false,
  hasVariants: true, images: [],
  variants: [{ id: 'var-1', label: 'White', code: 'OPT-0001', weightKg: 30, isActive: true }],
  sync: { hlc: 'h1', version: 1, fieldHlc: {} },
};

describe('Products', () => {
  /**
   * The module's own entry. Two sidebar labels read "Products" (the module and
   * its `catalog.nav.mainProducts` page), so this takes the first, which is the
   * module's: a module precedes the pages folded under it.
   */
  const moduleEntry = () => screen.getAllByTitle(t('nav.products'))[0]!;

  async function openProducts(permissions: string[]): Promise<Call[]> {
    const calls = await boot(permissions, (call) => {
      const path = call.url.split('?')[0];
      if (path === '/api/products') {
        return json({ items: [PRODUCT], total: 1, limit: 100, offset: 0 });
      }
      return undefined;
    });
    await act(async () => {
      fireEvent.click(moduleEntry());
      await wait(0);
    });
    return calls;
  }

  it('is offered only with products.view', async () => {
    await boot(['leads.view']);
    expect(screen.queryByTitle(t('nav.products'))).toBeNull();

    cleanup();
    await boot(['leads.view', 'products.view']);
    expect(moduleEntry()).toBeTruthy();
  });

  it('opens a row as a sub-screen with a way back', async () => {
    await openProducts(['products.view']);

    fireEvent.click(await screen.findByText(PRODUCT.name));

    const back = await screen.findByRole('button', { name: t('action.backToList') });
    expect(screen.getAllByTitle(PRODUCT.name).length).toBeGreaterThan(0);
    // Without products.edit the detail is read-only.
    expect(screen.queryByRole('button', { name: t('product.detail.editAction') })).toBeNull();

    fireEvent.click(back);
    expect(await screen.findByText(PRODUCT.name)).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('action.backToList') })).toBeNull();
  });

  it('offers Edit on the detail with products.edit', async () => {
    await openProducts(['products.view', 'products.edit']);

    fireEvent.click(await screen.findByText(PRODUCT.name));

    expect(await screen.findByRole('button', { name: t('product.detail.editAction') })).toBeTruthy();
  });

  it('reads the catalogue again when a product changes elsewhere', async () => {
    const calls = await openProducts(['products.view']);
    await screen.findByText(PRODUCT.name);
    const before = gets(calls, '/api/products');

    await changed('product');

    await waitFor(() => expect(gets(calls, '/api/products')).toBeGreaterThan(before));
  });
});

const PARTY = {
  id: 'party-1', partyCode: 'P-0001', name: 'Shree Ceramics', phone: '98250 00000', altPhone: null,
  email: null, addressLine1: null, addressLine2: null, city: 'Rajkot', state: null, pincode: null,
  gstNumber: null, notes: null, createdAt: '2026-09-01T10:00:00.000Z', recordCount: 1, myAccess: null,
};

/** Pushes a dashboard summary down the live socket, as the Master does on connect. */
async function summaryArrives(summary: Record<string, unknown>): Promise<void> {
  const live = () => sockets.all.filter((socket) => !socket.closed).at(-1);
  await waitFor(() => expect(live()).toBeDefined());
  await act(async () => {
    live()!.emit('dashboard:changed', { asOf: '2026-10-01T09:00:00.000Z', ...summary });
    await wait(0);
  });
}

describe('the Dashboard', () => {
  it('draws a card only for a figure the server sent', async () => {
    await boot(['leads.view']);

    await summaryArrives({ leadCount: 3, followUpsDueCount: 2 });

    expect(await screen.findByText(t('dashboard.leads.title'))).toBeTruthy();
    expect(screen.getByText(t('dashboard.leads.due', { count: 2 }))).toBeTruthy();
    expect(screen.queryByText(t('dashboard.stat.convertedToday'))).toBeNull();
    expect(screen.queryByText(t('dashboard.stat.panelsOnline'))).toBeNull();
    expect(screen.queryByText(t('dashboard.orders.title'))).toBeNull();
  });

  it("draws the day's converted and dispatched counts when the server sends them", async () => {
    await boot(['orders.view']);

    await summaryArrives({ openOrderCount: 4, convertedTodayCount: 2, dispatchedTodayCount: 1 });

    expect(await screen.findByText(t('dashboard.stat.convertedToday'))).toBeTruthy();
    expect(screen.getByText(t('dashboard.stat.dispatchedToday'))).toBeTruthy();
    // Fed by the Printroom and the Chatroom, which this release does not have.
    expect(screen.queryByText(t('dashboard.stat.printPending'))).toBeNull();
    expect(screen.queryByText(t('dashboard.stat.chatUnread'))).toBeNull();
  });

  it('reads no leads without leads.view', async () => {
    const calls = await boot(['orders.view']);
    await summaryArrives({ openOrderCount: 1 });
    await screen.findByText(t('dashboard.orders.title'));

    expect(calls.some((call) => call.url.split('?')[0] === '/api/leads')).toBe(false);
  });

  it('opens the lead a follow-up row names', async () => {
    const calls = await boot(['leads.view'], (call) => {
      const path = call.url.split('?')[0];
      if (path === '/api/leads') return json({ items: [LEAD], total: 1, limit: 8, offset: 0 });
      if (path === `/api/leads/${LEAD.id}`) return json(LEAD);
      return undefined;
    });
    await screen.findByText(LEAD.partyName);
    expect(
      calls.some((call) => call.url.includes('followUpDueOnly=true') && call.url.includes('limit=8')),
    ).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByText(LEAD.partyName));
      await wait(0);
    });

    expect(await screen.findByRole('button', { name: t('action.backToList') })).toBeTruthy();
  });
});

describe('Parties', () => {
  const answers = (call: Call) => {
    const path = call.url.split('?')[0];
    if (path === '/api/parties') return json({ items: [PARTY], total: 1, limit: 100, offset: 0 });
    if (path === `/api/parties/${PARTY.id}`) return json(PARTY);
    if (path === `/api/parties/${PARTY.id}/variants`) return json([]);
    return undefined;
  };

  it('opens a row as a sub-screen that reads the party’s own records', async () => {
    const calls = await boot(['parties.view'], answers);
    await open(t('nav.master.parties'));

    fireEvent.click(await screen.findByText(PARTY.name));

    expect(await screen.findByRole('button', { name: t('action.backToList') })).toBeTruthy();
    expect(screen.getAllByTitle(PARTY.name).length).toBeGreaterThan(0);
    await waitFor(() =>
      expect(calls.some((call) => call.url === `/api/parties/${PARTY.id}/variants`)).toBe(true),
    );
    // Without parties.edit the detail has no Edit, and without party.assign no access button.
    expect(screen.queryByRole('button', { name: t('party.detail.editAction') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('nav.master.partyAccess') })).toBeNull();
  });

  it('lands a search hit on the party’s detail, fetching it when the list lacks it', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const calls = await boot(['parties.view'], (call) => {
      const path = call.url.split('?')[0];
      if (path === '/api/search') {
        return json([{ kind: 'party', id: PARTY.id, title: PARTY.name, subtitle: null, rank: 1 }]);
      }
      if (path === '/api/parties') return json({ items: [], total: 0, limit: 100, offset: 0 });
      return answers(call);
    });

    fireEvent.click(screen.getByRole('button', { name: t('keys.command.palette') }));
    fireEvent.change(await screen.findByLabelText(t('keys.palette.placeholder')), {
      target: { value: 'shree' },
    });
    const hit = await screen.findByText(PARTY.name);
    await act(async () => {
      fireEvent.click(hit);
      await wait(0);
    });

    expect(await screen.findByRole('button', { name: t('action.backToList') })).toBeTruthy();
    expect(calls.some((call) => call.url === `/api/parties/${PARTY.id}`)).toBe(true);
  });
});

describe('changing your own password', () => {
  it('ends on sign-in saying the password changed', async () => {
    await boot(ADMIN, ({ method, url }) =>
      url === '/api/access/me/password' && method === 'POST'
        ? new Response(null, { status: 204 })
        : undefined,
    );

    fireEvent.click(
      within(document.querySelector<HTMLElement>('.ob-topbar')!).getByRole('button', {
        name: t('action.changePassword'),
      }),
    );
    fireEvent.change(await screen.findByLabelText(t('access.changePassword.current')), {
      target: { value: 'old-secret' },
    });
    fireEvent.change(screen.getByLabelText(t('access.changePassword.new')), {
      target: { value: 'new-secret-1' },
    });
    fireEvent.change(screen.getByLabelText(t('access.changePassword.confirm')), {
      target: { value: 'new-secret-1' },
    });
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole('dialog')).getByRole('button', {
          name: t('access.changePassword.submit'),
        }),
      );
      await wait(0);
    });

    expect(await screen.findByText(t('signIn.notice.passwordChanged'))).toBeTruthy();
  });
});

describe('Settings', () => {
  it('reaches Appearance for a leads.view-only user, without the manager’s reads', async () => {
    const calls = await boot(['leads.view']);

    await open(t('nav.master.settings'));

    expect(await screen.findByTitle(t('settings.tab.appearance'))).toBeTruthy();
    expect(screen.getByTitle(t('settings.tab.shortcuts'))).toBeTruthy();
    // `leads` is left out: its label is the sidebar's own "Pending Orders".
    for (const tab of ['company', 'connection', 'storage']) {
      expect(screen.queryByTitle(t(`settings.tab.${tab}`))).toBeNull();
    }
    const paths = calls.map((call) => call.url.split('?')[0]);
    for (const refused of ['/api/setup/identity', '/api/settings', '/api/storage']) {
      expect(paths).not.toContain(refused);
    }
  });

  it('offers a manager the company tabs as well', async () => {
    await boot(ADMIN);
    await open(t('nav.master.settings'));
    expect(await screen.findByTitle(t('settings.tab.connection'))).toBeTruthy();
  });
});

describe('Office panels, Roles & users and the Activity log', () => {
  const PANEL = {
    id: 'panel-1', name: 'Front desk', deviceCode: 'DSK-1', status: 'active', roleId: null,
    lanIp: null, pairedAt: null, lastSeenAt: null, createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z', isConnected: false, runtime: null,
  };
  const ROLE = {
    id: 'role-9', tenantId: 't', name: 'Packer', tier: 'office', permissions: [], isSystem: false,
    userCount: 0, deletedAt: null, createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    sync: { version: 1, hlc: 'h', fieldHlc: {}, temporaryId: null },
  };
  const ENTRY = {
    id: 'log-1', sequence: '77', tenantId: 't', entityType: 'lead', entityId: 'lead-1',
    action: 'created', actor: { type: 'user', id: 'user-1', name: 'Owner' }, details: {},
    createdAt: '2026-09-01T00:00:00.000Z', hash: 'ab', chained: true,
  };
  const PERMS = [...ADMIN, 'roles.edit', 'logs.view'];

  it('opens a panel as a sub-screen that reads GET /api/panels/:id', async () => {
    const calls = await boot(PERMS, ({ url }) => {
      if (url === '/api/panels/panel-1') {
        return json({
          ...PANEL,
          role: { id: null, name: 'Office', tier: 'office', permissions: [], isFallback: true },
          work: { leads: 4, orders: 2, lastActionAt: null },
        });
      }
      return undefined;
    });
    await open(t('nav.master.panels'));
    // The list reaches the panel over the socket, not a request.
    await waitFor(() => expect(sockets.all.some((socket) => !socket.closed)).toBe(true));
    await act(async () => {
      sockets.all.filter((socket) => !socket.closed).at(-1)!.emit('panels:changed', [PANEL]);
      await wait(0);
    });

    fireEvent.click(await screen.findByText(PANEL.name));

    const back = await screen.findByRole('button', { name: t('action.backToList') });
    await waitFor(() => expect(calls.some((call) => call.url === '/api/panels/panel-1')).toBe(true));
    expect(await screen.findByText(t('panels.detail.work'))).toBeTruthy();
    fireEvent.click(back);
    expect(screen.queryByRole('button', { name: t('action.backToList') })).toBeNull();
  });

  it('opens a log entry as a sub-screen with a way back', async () => {
    await boot(PERMS, ({ url }) => {
      const path = url.split('?')[0];
      if (path === '/api/logs') return json({ items: [ENTRY], nextCursor: null, prevCursor: null });
      if (path === '/api/logs/facets') return json({ actors: [], entityTypes: [], actions: [] });
      return undefined;
    });
    await open(t('nav.master.logs'));

    fireEvent.click(await screen.findByText('77'));

    expect(await screen.findByRole('button', { name: t('action.backToList') })).toBeTruthy();
  });

  it('reads the role again when it is opened for editing', async () => {
    const calls = await boot(PERMS, ({ url }) => {
      if (url === '/api/access/roles') return json([ROLE]);
      if (url === '/api/access/permission-catalogue') {
        return json({ modules: [], actions: [], groups: [], capabilities: [], tiers: ['office'], minimumTier: {} });
      }
      if (url === `/api/access/roles/${ROLE.id}`) return json(ROLE);
      return undefined;
    });
    await open(t('nav.master.access'));
    fireEvent.click(await screen.findByTitle(t('access.tab.roles')));

    fireEvent.click(await screen.findByText(ROLE.name));
    fireEvent.click(await screen.findByRole('button', { name: t('access.roles.edit') }));

    await waitFor(() =>
      expect(calls.some((call) => call.url === `/api/access/roles/${ROLE.id}`)).toBe(true),
    );
  });
});

describe('Server Masters at first run and sign-in (1.3)', () => {
  /** Boots to whatever the setup status leads to, without waiting for a signed-in shell. */
  async function bootTo(route: (call: Call) => Response | undefined): Promise<Call[]> {
    const calls = routeFetch(route);
    const App = await loadApp('master');
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    return calls;
  }

  const signedOut =
    (status: Record<string, unknown>) =>
    ({ url }: Call): Response | undefined => {
      const path = url.split('?')[0];
      if (path === '/api/setup/status') return json({ setupComplete: true, ...status });
      if (path === '/api/auth/me') return json({ error: 'unauthorized' }, 401);
      return undefined;
    };

  it('first run asks for two Server Master accounts and creates no admin', async () => {
    const calls = await bootTo(({ url, method }) => {
      if (url === '/api/setup/status') {
        return json({ setupComplete: false, onMasterPc: true, serverMasterSetupNeeded: false });
      }
      if (url === '/api/setup/initialize' && method === 'POST') {
        return json(
          {
            masterUniqueId: 'MASTER-1',
            accounts: [
              { username: 'master', displayName: 'Owner' },
              { username: 'master-backup', displayName: 'Partner' },
            ],
            pairingPassword: 'pair-word',
            lanIps: [],
            port: 4000,
          },
          201,
        );
      }
      return undefined;
    });

    fireEvent.click(await screen.findByRole('button', { name: t('firstRun.choose.newSite') }));

    const usernames = screen.getAllByLabelText<HTMLInputElement>(t('firstRun.serverMaster.username'));
    expect(usernames.map((input) => input.value)).toEqual(['master', 'master-backup']);

    const names = screen.getAllByLabelText(t('firstRun.serverMaster.displayName'));
    const passwords = screen.getAllByLabelText(t('firstRun.serverMaster.password'));
    const confirms = screen.getAllByLabelText(t('firstRun.serverMaster.confirmPassword'));
    fireEvent.change(names[0]!, { target: { value: 'Owner' } });
    fireEvent.change(names[1]!, { target: { value: 'Partner' } });
    fireEvent.change(passwords[0]!, { target: { value: 'Owner@1234' } });
    fireEvent.change(passwords[1]!, { target: { value: 'Partner@1234' } });
    fireEvent.change(confirms[0]!, { target: { value: 'Owner@1234' } });
    // A mismatch is caught here, before anything is sent.
    fireEvent.change(confirms[1]!, { target: { value: 'Partner@9999' } });

    const generate = screen.getByRole('button', { name: t('firstRun.setup.generate') });
    await act(async () => {
      fireEvent.click(generate);
      await wait(0);
    });
    expect(screen.getByText(t('firstRun.serverMaster.passwordMismatch'))).toBeTruthy();
    expect(calls.some((call) => call.url === '/api/setup/initialize')).toBe(false);

    fireEvent.change(confirms[1]!, { target: { value: 'Partner@1234' } });
    await act(async () => {
      fireEvent.click(generate);
      await wait(0);
    });

    const sent = calls.find((call) => call.url === '/api/setup/initialize');
    expect(sent?.body).toEqual({
      companyName: '',
      accounts: [
        { username: 'master', displayName: 'Owner', password: 'Owner@1234' },
        { username: 'master-backup', displayName: 'Partner', password: 'Partner@1234' },
      ],
    });
    expect(JSON.stringify(sent?.body)).not.toContain('admin');

    expect(await screen.findByText(t('firstRun.ready.title'))).toBeTruthy();
    expect(screen.getByText('master-backup')).toBeTruthy();
    expect(screen.getByText('pair-word')).toBeTruthy();
  });

  it('first run on a LAN browser says it is done at the Master PC, with no setup or restore', async () => {
    await bootTo(({ url }) =>
      url === '/api/setup/status'
        ? json({ setupComplete: false, onMasterPc: false, serverMasterSetupNeeded: false })
        : undefined,
    );

    expect(await screen.findByText(t('firstRun.choose.masterPcOnly'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('firstRun.choose.newSite') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('firstRun.choose.restore') })).toBeNull();
  });

  it('signs in with an empty username, never a suggested admin', async () => {
    await bootTo(signedOut({ onMasterPc: false, serverMasterSetupNeeded: false }));

    const username = await screen.findByLabelText<HTMLInputElement>(t('signIn.field.username'));
    expect(username.value).toBe('');
    // A LAN browser is not offered the Master-PC recovery flow.
    expect(screen.queryByRole('button', { name: t('masterKey.recover.link') })).toBeNull();
  });

  it('on the Master PC, shows the Server Master setup first when it is owed, with no skip', async () => {
    await bootTo(signedOut({ onMasterPc: true, serverMasterSetupNeeded: true }));

    expect(await screen.findByText(t('masterKey.setup.title'))).toBeTruthy();
    expect(screen.getByLabelText(t('masterKey.label'))).toBeTruthy();
    expect(screen.queryByLabelText(t('signIn.field.username'))).toBeNull();
  });

  it('keeps a LAN browser on the ordinary sign-in while the setup is owed', async () => {
    await bootTo(signedOut({ onMasterPc: false, serverMasterSetupNeeded: true }));

    expect(await screen.findByLabelText(t('signIn.field.username'))).toBeTruthy();
    expect(screen.queryByText(t('masterKey.setup.title'))).toBeNull();
  });

  it('offers the master-key recovery on the Master PC', async () => {
    await bootTo(signedOut({ onMasterPc: true, serverMasterSetupNeeded: false }));

    fireEvent.click(await screen.findByRole('button', { name: t('masterKey.recover.link') }));

    expect(await screen.findByText(t('masterKey.recover.title'))).toBeTruthy();
    expect(screen.getByLabelText(t('masterKey.label'))).toBeTruthy();
  });

  it('badges a signed-in Server Master in the footer', async () => {
    await boot(ADMIN, ({ url }) =>
      url === '/api/auth/me'
        ? json({ user: user(ADMIN, 'server_master'), sessionToken: 'session-1', defaultLocale: 'en' })
        : undefined,
    );

    const footer = document.querySelector('.ob-footer')!;
    expect(footer.querySelector('[data-server-master]')).not.toBeNull();
    expect(footer.querySelector('.ob-avatar[data-highlight="true"]')).not.toBeNull();
  });
});
