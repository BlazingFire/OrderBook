/**
 * The Master Panel's shell, booted whole in jsdom (`panel-harness.ts` says
 * how; the live socket is the one extra edge replaced here). What it pins:
 *
 *  · the gallery, opened at #/gallery, stays open;
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

import { buildPermissionCatalogue } from '@orderbook/shared';

import { formatElapsed } from '../src/format.js';
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
    /** How often the panel asked it to connect again by hand. */
    connects = 0;
    private readonly handlers = new Map<string, Array<(payload: unknown) => void>>();

    on(event: string, handler: (payload: unknown) => void): this {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
      return this;
    }

    close(): void {
      this.closed = true;
    }

    connect(): void {
      this.connects += 1;
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
      return json({ user: user(permissions), sessionToken: 'session-1' });
    }
    if (path === '/api/access/users' || path === '/api/access/roles') return json([]);
    if (path === '/api/access/permission-catalogue') {
      return json({ modules: [], capabilities: [], tiers: [] });
    }
    if (path === '/api/pipelines') return json([]);
    // Answered for every test: `api.ts` shares one in-flight GET per path across
    // the file, so a bell read left hanging by one test would swallow the next's.
    if (path === '/api/notifications') return json({ items: [], unreadCount: 0 });
    // The notice board's read, answered for every test for the same reason: a read left hanging by one
    // test would swallow the next one's (the in-flight GET sharing in `api.ts`).
    if (path === '/api/notices') return json({ notices: [], unreadCount: 0 });
    // The faces on a board's rows (R22), nobody by default, for the same reason.
    if (path === '/api/presence/board') {
      return json({ recordKind: url.includes('kind=order') ? 'order' : 'lead', records: {} });
    }
    // The Products module: its categories, and the catalogue page it lists from.
    if (path === '/api/categories') return json([]);
    if (path === '/api/products') return json({ items: [], total: 0, limit: 100, offset: 0 });
    if (path === '/api/option-lists') return json([]);
    // The New / Edit pending order form: its view, and its three pickers.
    if (path === '/api/lead-entry') {
      return json({ optionLists: [], partyVariants: [], partyGrants: [], features: {} });
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
  await waitFor(() => expect(document.querySelector('.ob-footer')).not.toBeNull());
  // The shell can be on screen before React has run its mount effects: a state update that
  // arrives from a fetch, outside `act`, commits at once and leaves the passive effects to a
  // later scheduler task. Under load that task is late, and a keystroke sent now finds the
  // keyboard listener not yet attached (the sign-out chord test failed this way about one run
  // in six). Flushing here makes "the shell is up" mean the shell is wired.
  await act(async () => {
    await wait(0);
  });
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
  it('stays open after the hash changes to #/gallery', async () => {
    await boot(ADMIN);

    await act(async () => {
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

  it('1.4 R13: the sign-out chord asks first, and signs out only on confirm', async () => {
    const calls = await boot(ADMIN, answers);
    const chord = () =>
      act(async () => {
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'L', code: 'KeyL', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }),
        );
        await wait(0);
      });
    const signedOut = () => calls.some((call) => call.url === '/api/auth/sign-out' && call.method === 'POST');

    await chord();
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain(t('signOut.confirm.title'));
    expect(signedOut()).toBe(false);

    fireEvent.click(within(dialog).getByRole('button', { name: t('common.cancel') }));
    await act(async () => wait(0));
    expect(signedOut()).toBe(false);

    await chord();
    await act(async () => {
      fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: t('action.signOut') }));
      await wait(0);
    });
    expect(signedOut()).toBe(true);
  }, 20_000);

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

describe('Reports', () => {
  const REPORT_OPTIONS = { kinds: ['dispatches', 'by-user'], subjects: [{ id: 'user-1', name: 'Owner' }], canExport: true };
  const REPORT_TABLE = {
    kind: 'dispatches',
    range: { period: 'last6Months', fromDate: '2026-05-01', toDateExclusive: '2026-11-01', months: ['2026-05', '2026-10'], timeZone: 'Asia/Kolkata' },
    subject: { id: null, name: null },
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

  /** Boots as a person of the given tier, whose company features are as given. */
  function bootWith(tier: string, permissions: string[], features: Record<string, unknown> = {}): Promise<Call[]> {
    return boot(permissions, ({ url }) => {
      const path = url.split('?')[0] ?? url;
      if (path === '/api/auth/me') {
        return json({ user: { ...user(permissions, tier), features }, sessionToken: 'session-1' });
      }
      if (path === '/api/reports/options') return json(REPORT_OPTIONS);
      if (path.startsWith('/api/reports/table/')) return json(REPORT_TABLE);
      return undefined;
    });
  }

  // Sidebar rows carry their label as a title; Basic Home's tiles do not.
  const reportsRow = () => screen.queryByTitle(t('nav.reports'));

  it('is a Work row that opens the first kind on offer, asking the Master for its table', async () => {
    const calls = await bootWith('admin', ['reports.view', 'reports.export']);

    await act(async () => {
      fireEvent.click(reportsRow()!);
      await wait(0);
    });

    expect(await screen.findByText('2026-10')).toBeTruthy();
    expect(document.querySelector('.ob-topbar')?.textContent).toContain(t('reports.kind.dispatches'));
    const asked = calls.map((call) => call.url);
    expect(asked).toContain('/api/reports/options');
    expect(asked.some((url) => url.startsWith('/api/reports/table/dispatches'))).toBe(true);
  });

  it('is not offered without reports.view', async () => {
    await bootWith('admin', ['leads.view']);
    expect(reportsRow()).toBeNull();
  });

  it('follows the company switch for Management, and never hides from an Administrator', async () => {
    await bootWith('management', ['reports.view'], { reportsVisibleToManagement: false });
    expect(reportsRow()).toBeNull();
    cleanup();

    await bootWith('management', ['reports.view'], { reportsVisibleToManagement: true });
    expect(reportsRow()).not.toBeNull();
    cleanup();

    await bootWith('admin', ['reports.view'], { reportsVisibleToManagement: false, reportsVisibleToOffice: false });
    expect(reportsRow()).not.toBeNull();
  });
});

describe('Basic Home and the landing screen', () => {
  const MANAGER = ['leads.view', 'leads.create', 'products.view'];

  /** Boots as somebody whose role has the given tier. */
  function bootAs(tier: string, permissions: string[]): Promise<Call[]> {
    return boot(permissions, ({ url }) =>
      url === '/api/auth/me'
        ? json({ user: user(permissions, tier), sessionToken: 'session-1' })
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
      // 1.4 D3: everyone reads the brand, packaging and grade lists.
      t('nav.lists'),
      t('nav.master.settings'),
      t('nav.updates'),
    ]);
  });

  it('1.4 R9: shows Chatroom and Printroom tiles for Management holding chat.use and print.send', async () => {
    // Answer the chat and print routes the shell asks once it holds the keys.
    const permissions = [...MANAGER, 'chat.use', 'print.send'];
    await boot(permissions, ({ url }) => {
      const path = url.split('?')[0];
      if (url === '/api/auth/me') {
        return json({ user: user(permissions, 'management'), sessionToken: 'session-1' });
      }
      if (path === '/api/chat/rooms' || path === '/api/chat/tasks') return json([]);
      if (path === '/api/print-jobs') return json({ jobs: [], nextCursor: null, waitingCount: 0 });
      if (path === '/api/print-stations') return json([]);
      return undefined;
    });

    const tiles = [...launcher().querySelectorAll('.ob-tile-label')].map((tile) => tile.textContent);
    expect(tiles).toContain(t('nav.chatroom'));
    expect(tiles).toContain(t('nav.printroom'));
  });

  it('1.4 R9: shows neither tile without the keys', async () => {
    await bootAs('management', MANAGER);

    const tiles = [...launcher().querySelectorAll('.ob-tile-label')].map((tile) => tile.textContent);
    expect(tiles).not.toContain(t('nav.chatroom'));
    expect(tiles).not.toContain(t('nav.printroom'));
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

    // Change events inside one 80 ms window move the revision once, so the re-read follows the window.
    await waitFor(() => expect(gets(calls, '/api/leads')).toBeGreaterThan(before));
  });

  it('the shell re-reads the stages when a pipeline changes', async () => {
    const calls = await boot(ADMIN);
    await open(t('nav.leads'));
    const before = gets(calls, '/api/pipelines');
    expect(before).toBeGreaterThan(0);

    await changed('pipeline');

    await waitFor(() => expect(gets(calls, '/api/pipelines')).toBeGreaterThan(before));
  });

  it.each(['option_list', 'custom_field'])(
    'the Recycle Bin refetches when a %s row is deleted or restored',
    async (entity) => {
      const calls = await boot(ADMIN);
      await open(t('nav.master.recycleBin'));
      await waitFor(() => expect(gets(calls, '/api/recycle-bin')).toBeGreaterThan(0));
      const before = gets(calls, '/api/recycle-bin');

      await changed(entity);

      await waitFor(() => expect(gets(calls, '/api/recycle-bin')).toBeGreaterThan(before));
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
  linesWithoutWeight: 0, timeline: [],
  items: [{
    id: 'l1', variantId: 'v1', productName: 'Rustic Wood', categoryName: 'Duragres',
    size: '600x600', brandName: null, variantLabel: 'Ivory', colour: null, grade: null,
    packaging: 'Box', quantity: 12, weightKg: 2, lineWeightKg: 24,
  }],
};

/** Boots with one lead, one order and their party answering, then opens `label`. */
/** Extra fields for the lead and order `openList` serves, so a test can number them. Reset after each test. */
const fixtureExtras: { lead: Record<string, unknown>; order: Record<string, unknown> } = { lead: {}, order: {} };
afterEach(() => {
  fixtureExtras.lead = {};
  fixtureExtras.order = {};
});

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
    if (path === '/api/leads') return json({ items: [{ ...LEAD, ...fixtureExtras.lead }], total: 1, limit: 500, offset: 0 });
    if (path === '/api/orders') return json({ items: [{ ...ORDER, ...fixtureExtras.order }], total: 1, limit: 500, offset: 0 });
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
        ? json({ user: user(permissions), sessionToken: 'session-1' })
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

  it('is offered with the right to view orders alone: printing a note is not exporting data (R10)', async () => {
    await openOrders([...ADMIN]);
    expect(screen.getByRole('button', { name: t('orderNote.filling') })).toBeTruthy();
    expect(screen.getByRole('button', { name: t('orderNote.dispatch') })).toBeTruthy();
  });

  it('opens a note straight from the list row, without a click on the row itself (R10)', async () => {
    await openList([...ADMIN, 'parties.view'], t('nav.orders'));
    await screen.findByText(ORDER.id);
    fireEvent.click(screen.getByRole('button', { name: t('orderNote.dispatch') }));

    expect((await screen.findAllByText(t('orderNote.page', { n: 1, total: 1 }))).length).toBeGreaterThan(0);
  });

  it('opens the Dispatch note with the party fetched for its header, and prints through the shell', async () => {
    const printPage = vi.fn().mockResolvedValue({ ok: true });
    (window as { orderbook?: unknown }).orderbook = { shellVersion: 't', applyUpdate: vi.fn(), printPage };
    const calls = await openOrders([...ADMIN, 'orders.export', 'parties.view']);

    fireEvent.click(await screen.findByRole('button', { name: t('orderNote.dispatch') }));

    expect((await screen.findAllByText(t('orderNote.page', { n: 1, total: 1 }))).length).toBeGreaterThan(0);
    expect(calls.some((call) => call.url === '/api/parties/party-1')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: t('orderNote.print') }));
    // `copies` is always sent now (deliberate): one unless the person set more.
    await waitFor(() => expect(printPage).toHaveBeenCalledWith({ deviceName: undefined, copies: 1 }));

    // Back from the note lands on the order, and back from that on the list.
    fireEvent.click(screen.getByRole('button', { name: t('action.backToList') }));
    fireEvent.click(await screen.findByRole('button', { name: t('action.backToList') }));
    expect(await screen.findByText(ORDER.id)).toBeTruthy();
  });
});

describe('the Filling and Dispatch notes on a pending order', () => {
  async function openLeads(permissions: string[]) {
    const calls = await openList(permissions, t('nav.leads'));
    fireEvent.click(await screen.findByText(LEAD.id));
    await screen.findByRole('button', { name: t('action.backToList') });
    return calls;
  }

  afterEach(() => {
    delete (window as { orderbook?: unknown }).orderbook;
  });

  it('is offered with the right to view leads alone, no export right needed (R10)', async () => {
    await openLeads(['leads.view', 'parties.view']);
    expect(screen.getByRole('button', { name: t('orderNote.filling') })).toBeTruthy();
    expect(screen.getByRole('button', { name: t('orderNote.dispatch') })).toBeTruthy();
  });

  it('opens a note straight from the list row (R10)', async () => {
    await openList(['leads.view', 'parties.view'], t('nav.leads'));
    await screen.findByText(LEAD.id);
    fireEvent.click(screen.getByRole('button', { name: t('orderNote.filling') }));

    expect((await screen.findAllByText(t('orderNote.pendingOrderNo'))).length).toBeGreaterThan(0);
  });

  it('opens the Filling note headed "Pending Order No." with the lead id, party fetched', async () => {
    const calls = await openLeads(['leads.view', 'leads.export', 'parties.view']);
    fireEvent.click(screen.getByRole('button', { name: t('orderNote.filling') }));

    expect((await screen.findAllByText(t('orderNote.pendingOrderNo'))).length).toBeGreaterThan(0);
    expect(screen.queryByText(t('orderNote.orderId'))).toBeNull();
    expect(screen.getAllByText(LEAD.id).length).toBeGreaterThan(0);
    expect(calls.some((call) => call.url === '/api/parties/party-1')).toBe(true);

    // Back from the note lands on the lead.
    fireEvent.click(screen.getByRole('button', { name: t('action.backToList') }));
    expect(await screen.findByRole('button', { name: t('orderNote.filling') })).toBeTruthy();
  });

  it('prints the copies asked for through the shell, and keeps the vehicle number off the server', async () => {
    const printPage = vi.fn().mockResolvedValue({ ok: true });
    (window as { orderbook?: unknown }).orderbook = { shellVersion: 't', applyUpdate: vi.fn(), printPage };
    const calls = await openLeads(['leads.view', 'leads.export', 'parties.view']);
    fireEvent.click(screen.getByRole('button', { name: t('orderNote.dispatch') }));

    // A pending order has no vehicle column: the field takes input without leads.edit and saves nothing.
    const field = await screen.findByLabelText(t('orderNote.vehicleNo'));
    expect((field as HTMLInputElement).disabled).toBe(false);
    await act(async () => {
      fireEvent.change(field, { target: { value: 'gj 03  ab 4471' } });
      fireEvent.blur(field);
      await wait(0);
    });
    expect((field as HTMLInputElement).value).toBe('GJ 03 AB 4471');

    fireEvent.change(screen.getByLabelText(t('orderNote.copies')), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: t('orderNote.print') }));
    await waitFor(() => expect(printPage).toHaveBeenCalledWith({ deviceName: undefined, copies: 3 }));

    expect(calls.filter((call) => call.method !== 'GET' && call.url.startsWith('/api/leads'))).toEqual([]);
  });

  it('keeps the copies between 1 and 50', async () => {
    const printPage = vi.fn().mockResolvedValue({ ok: true });
    (window as { orderbook?: unknown }).orderbook = { shellVersion: 't', applyUpdate: vi.fn(), printPage };
    await openLeads(['leads.view', 'leads.export']);
    fireEvent.click(screen.getByRole('button', { name: t('orderNote.dispatch') }));
    const copies = await screen.findByLabelText(t('orderNote.copies'));

    fireEvent.change(copies, { target: { value: '500' } });
    fireEvent.click(screen.getByRole('button', { name: t('orderNote.print') }));
    await waitFor(() => expect(printPage).toHaveBeenLastCalledWith({ deviceName: undefined, copies: 50 }));

    fireEvent.change(copies, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: t('orderNote.print') }));
    await waitFor(() => expect(printPage).toHaveBeenLastCalledWith({ deviceName: undefined, copies: 1 }));
  });

  it('offers Save PDF only when the shell can, named for the lead and the note', async () => {
    const savePdf = vi.fn().mockResolvedValue({ ok: true, path: 'C:\\x.pdf' });
    (window as { orderbook?: unknown }).orderbook = { shellVersion: 't', applyUpdate: vi.fn(), printPage: vi.fn(), savePdf };
    await openLeads(['leads.view', 'leads.export']);
    fireEvent.click(screen.getByRole('button', { name: t('orderNote.filling') }));
    fireEvent.click(await screen.findByRole('button', { name: t('orderNote.savePdf') }));
    await waitFor(() => expect(savePdf).toHaveBeenCalledWith({ fileName: `${LEAD.id}-filling.pdf` }));
    cleanup();

    delete (window as { orderbook?: unknown }).orderbook;
    await openLeads(['leads.view', 'leads.export']);
    fireEvent.click(screen.getByRole('button', { name: t('orderNote.filling') }));
    await screen.findAllByText(t('orderNote.pendingOrderNo'));
    expect(screen.queryByRole('button', { name: t('orderNote.savePdf') })).toBeNull();
  });

  it('prints the PO number of a pending order and names the saved file for it', async () => {
    const savePdf = vi.fn().mockResolvedValue({ ok: true, path: 'C:/out.pdf' });
    (window as { orderbook?: unknown }).orderbook = { shellVersion: 'test', applyUpdate: vi.fn(), printPage: vi.fn(), savePdf };
    fixtureExtras.lead = { poNumber: 'PO/2026-27/00042' };
    await openList(['leads.view', 'leads.export'], t('nav.leads'));
    fireEvent.click(await screen.findByText('PO/2026-27/00042'));
    await screen.findByRole('button', { name: t('action.backToList') });
    fireEvent.click(screen.getByRole('button', { name: t('orderNote.filling') }));
    expect((await screen.findAllByText(t('orderNote.pendingOrderNo'))).length).toBeGreaterThan(0);
    expect(screen.getAllByText('PO/2026-27/00042').length).toBeGreaterThan(0);
    expect(screen.queryByText(LEAD.id)).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: t('orderNote.savePdf') }));
    await waitFor(() => expect(savePdf).toHaveBeenCalledWith({ fileName: 'PO/2026-27/00042-filling.pdf' }));
  });

  it('prints the pending order number on a final order made from one', async () => {
    fixtureExtras.order = { poNumber: 'PO/2026-27/00042' };
    await openList(['orders.view', 'orders.export'], t('nav.orders'));
    fireEvent.click(await screen.findByText(ORDER.id));
    await screen.findByRole('button', { name: t('action.backToList') });
    fireEvent.click(screen.getByRole('button', { name: t('orderNote.filling') }));
    expect((await screen.findAllByText(t('orderNote.orderId'))).length).toBeGreaterThan(0);
    expect(screen.getAllByText('PO/2026-27/00042').length).toBeGreaterThan(0);
  });

  it('heads a final order "Final Order No."', async () => {
    await openList(['orders.view', 'orders.export'], t('nav.orders'));
    fireEvent.click(await screen.findByText(ORDER.id));
    await screen.findByRole('button', { name: t('action.backToList') });
    fireEvent.click(screen.getByRole('button', { name: t('orderNote.filling') }));
    expect((await screen.findAllByText(t('orderNote.orderId'))).length).toBeGreaterThan(0);
    expect(screen.queryByText(t('orderNote.pendingOrderNo'))).toBeNull();
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
    const qty = await screen.findByLabelText(`${t('lead.add.draft.col.quantity')} — White`);
    fireEvent.change(qty, { target: { value: '5' } });
    await act(async () => {
      fireEvent.keyDown(qty, { key: 'Q', shiftKey: true });
      await wait(0);
    });
  }

  it('shows a product the catalogue gained while the form is open, with the party and the caret kept', async () => {
    // The Master's catalogue as the picker answers it right now; the test adds to it.
    let categories = [PICK_CATEGORY];
    await boot(CREATE, ({ url }) => {
      const path = url.split('?')[0] ?? url;
      if (path === '/api/pick/category') return json({ items: categories, truncated: false });
      return undefined;
    });
    await openFormByKey();

    fireEvent.change(screen.getByLabelText(t('lead.add.party.search')), { target: { value: 'Sha' } });
    fireEvent.click(await screen.findByRole('button', { name: /Sharma Traders/ }));
    fireEvent.focus(searchBox());
    await screen.findByRole('button', { name: /ONE PIECE TOILET/ });
    expect(screen.queryByRole('button', { name: /NEW PAN RANGE/ })).toBeNull();
    const box = searchBox() as HTMLInputElement;
    box.focus();

    // An administrator adds a product; the Master pushes a catalogue change to this window.
    categories = [
      ...categories,
      { id: 'cat-2', name: 'NEW PAN RANGE', code: 'NPR', brand: 'Swisware+', sortOrder: 2 },
    ];
    await changed('product');

    // It is on offer at once: nothing was closed and reopened, the party is still chosen,
    // and the caret is still in the search box.
    expect(await screen.findByRole('button', { name: /NEW PAN RANGE/ })).toBeTruthy();
    expect(screen.queryByLabelText(t('lead.add.party.search'))).toBeNull();
    expect(document.activeElement).toBe(searchBox());
  });

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

  it('is listed once in the sidebar while it is open, and that row is the current page', async () => {
    await boot(CREATE);
    await openFormByKey();

    const rows = screen.getAllByTitle(t('lead.add.title'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.getAttribute('aria-current')).toBe('page');
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

  it('offers no Owner picker when the Master sends no owners (no record.reassignOwner)', async () => {
    await boot(CREATE);
    await openFormByKey();
    expect(screen.queryByLabelText(t('lead.add.owner'))).toBeNull();
  });

  it('raises a pending order for another user through the Owner picker when the Master sends owners', async () => {
    let body: Record<string, unknown> | null = null;
    const OWNERS = [
      { id: 'user-sm', displayName: 'Owner', username: 'master', roleName: 'Server Master', roleTier: 'server_master', avatar: null },
      { id: 'user-ravi', displayName: 'Ravi Kumar', username: 'ravi', roleName: 'Sales', roleTier: 'office', avatar: null },
    ];
    await boot([...CREATE, 'record.reassignOwner'], (call) => {
      const path = call.url.split('?')[0];
      if (path === '/api/lead-entry') {
        return json({
          optionLists: [],
          partyVariants: [],
          partyGrants: [],
          features: {},
          owners: OWNERS,
        });
      }
      if (path === '/api/leads' && call.method === 'POST') {
        body = call.body as Record<string, unknown>;
        return json({ ...LEAD, id: 'LD0000000003', poNumber: 'PO/2026-27/00003' }, 201);
      }
      return undefined;
    });
    await openFormByKey();
    await fillOneLine();
    const picker = (await screen.findByLabelText(t('lead.add.owner'))) as HTMLInputElement;
    // The caller by default; the Master assumes them when nobody else is chosen.
    expect(picker.value).toBe(t('lead.add.owner.me'));
    picker.focus();
    // A Server Master is marked as one in the list.
    fireEvent.change(picker, { target: { value: 'Server' } });
    expect(await screen.findByText(`Owner · ${t('presence.serverMaster')}`)).toBeTruthy();
    fireEvent.change(picker, { target: { value: 'Ravi' } });
    fireEvent.keyDown(picker, { key: 'Enter' });
    expect(picker.value).toBe('Ravi Kumar');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('lead.add.save') }));
      await wait(0);
    });

    expect(body).toMatchObject({ ownerId: 'user-ravi' });
    // The toast names the lead by the number the Master gave it.
    expect(
      await screen.findByText(t('lead.add.savedOnline', { id: 'PO/2026-27/00003' })),
    ).toBeTruthy();
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

  describe('Photo import', () => {
    it('is offered only with products.edit', async () => {
      await openProducts(['products.view']);
      expect(screen.queryByText(t('catalog.nav.photoImport'))).toBeNull();
    });

    it('previews a chosen folder and uploads the matched photo to its sub product', async () => {
      const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
      const calls = await boot(['products.view', 'products.edit'], (call) => {
        const path = call.url.split('?')[0];
        if (path === '/api/products') return json({ items: [PRODUCT], total: 1, limit: 100, offset: 0 });
        if (path === `/api/products/${PRODUCT.id}/images`) return json(PRODUCT, 201);
        return undefined;
      });
      await act(async () => {
        fireEvent.click(moduleEntry());
        await wait(0);
      });
      fireEvent.click(await screen.findByText(t('catalog.nav.photoImport')));

      const [folder] = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"][webkitdirectory]'));
      await act(async () => {
        fireEvent.change(folder!, {
        target: {
          files: [
            new File([jpegBytes], 'opt-0001.jpg', { type: 'image/jpeg' }),
            new File([jpegBytes], 'NOPE-9.jpg', { type: 'image/jpeg' }),
            // Named like a photo, but its bytes say otherwise: flagged before any upload.
            new File(['notes, not a photo'], 'OPT-0001_2.jpg', { type: 'image/jpeg' }),
          ],
        },
        });
        await wait(0);
      });

      expect(await screen.findByText('opt-0001.jpg')).toBeTruthy();
      expect(screen.getAllByText(PRODUCT.name).length).toBeGreaterThan(0);
      expect(screen.getByText(t('photoImport.status.unmatched'))).toBeTruthy();
      expect(screen.getByText(t('photoImport.status.notImage'))).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: t('photoImport.start', { count: 1 }) }));

      await waitFor(() => {
        const uploads = calls.filter((call) => call.url === `/api/products/${PRODUCT.id}/images`);
        expect(uploads.map((call) => call.method)).toEqual(['POST']);
      });
      expect(await screen.findByText(`${t('photoImport.result.imported')} - ${t('photoImport.status.new')}`)).toBeTruthy();
    });
  });

  describe('Duplicates', () => {
    const MEMBER = {
      code: 'WB', size: null, productName: null, subProductCount: 0, lineCount: 0, blockedBy: null,
    };
    const GROUP = {
      key: 'product:A+B', level: 'product', brand: 'Swisware+', matchedOn: ['name'],
      members: [
        { ...MEMBER, id: 'A', name: 'Wash Basin', createdAt: '2026-01-01T00:00:00.000Z' },
        { ...MEMBER, id: 'B', name: 'Wash-basin', code: 'WB2', createdAt: '2026-02-01T00:00:00.000Z' },
      ],
    };

    it('is offered only with products.delete', async () => {
      await openProducts(['products.view']);
      expect(screen.queryByText(t('catalog.nav.duplicates'))).toBeNull();
    });

    it('lists the groups, keeps the oldest by default and deletes the other copy after a confirm', async () => {
      const calls = await boot(['products.view', 'products.delete'], (call) => {
        const path = call.url.split('?')[0];
        if (path === '/api/duplicates') return json({ groups: [GROUP] });
        if (path === '/api/duplicates/resolve') return json({ deleted: ['B'], refused: [] });
        return undefined;
      });
      await act(async () => {
        fireEvent.click(moduleEntry());
        await wait(0);
      });
      fireEvent.click(await screen.findByText(t('catalog.nav.duplicates')));

      expect(await screen.findByText('Wash-basin')).toBeTruthy();
      expect((screen.getAllByRole('radio')[0] as HTMLInputElement).checked).toBe(true);

      fireEvent.click(screen.getByRole('button', { name: t('duplicates.delete') }));
      const dialog = await screen.findByRole('dialog');
      fireEvent.click(within(dialog).getByRole('button', { name: t('duplicates.delete') }));

      await waitFor(() => {
        const post = calls.find((call) => call.url === '/api/duplicates/resolve');
        expect(post?.method).toBe('POST');
        expect(post?.body).toEqual({ level: 'product', keepId: 'A', deleteIds: ['B'] });
      });
    });

    it('sends the copy chosen to keep, not the oldest', async () => {
      const calls = await boot(['products.view', 'products.delete'], (call) => {
        const path = call.url.split('?')[0];
        if (path === '/api/duplicates') return json({ groups: [GROUP] });
        if (path === '/api/duplicates/resolve') return json({ deleted: ['A'], refused: [] });
        return undefined;
      });
      await act(async () => {
        fireEvent.click(moduleEntry());
        await wait(0);
      });
      fireEvent.click(await screen.findByText(t('catalog.nav.duplicates')));
      await screen.findByText('Wash-basin');

      fireEvent.click(screen.getAllByRole('radio')[1]!);
      fireEvent.click(screen.getByRole('button', { name: t('duplicates.delete') }));
      const dialog = await screen.findByRole('dialog');
      fireEvent.click(within(dialog).getByRole('button', { name: t('duplicates.delete') }));

      await waitFor(() =>
        expect(calls.find((call) => call.url === '/api/duplicates/resolve')?.body).toEqual({
          level: 'product', keepId: 'B', deleteIds: ['A'],
        }),
      );
    });

    it('says why a copy cannot be deleted and offers nothing to delete when none can', async () => {
      const blocked = {
        ...GROUP,
        members: [
          GROUP.members[0],
          { ...GROUP.members[1], blockedBy: 'subProducts', subProductCount: 3 },
        ],
      };
      await boot(['products.view', 'products.delete'], (call) =>
        call.url.split('?')[0] === '/api/duplicates' ? json({ groups: [blocked] }) : undefined,
      );
      await act(async () => {
        fireEvent.click(moduleEntry());
        await wait(0);
      });
      fireEvent.click(await screen.findByText(t('catalog.nav.duplicates')));

      expect(await screen.findByText(t('duplicates.blocked.subProducts', { count: 3 }))).toBeTruthy();
      expect((screen.getByRole('button', { name: t('duplicates.delete') }) as HTMLButtonElement).disabled).toBe(true);
    });
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
    for (const tab of ['company', 'connection', 'storageBackup']) {
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

  async function openStorageTab(): Promise<void> {
    await open(t('nav.master.settings'));
    await act(async () => {
      fireEvent.click(await screen.findByTitle(t('settings.tab.storageBackup')));
      await wait(0);
    });
    // The version 1 export is there either way, so the tab has drawn.
    await screen.findByRole('button', { name: t('backup.export.action') });
  }

  it('has no backup-everything sections without storage.backupAll', async () => {
    const calls = await boot([...ADMIN, 'storage.manage']);
    await openStorageTab();

    expect(screen.queryByText(t('backupAll.title'))).toBeNull();
    expect(screen.queryByText(t('autoBackup.title'))).toBeNull();
    expect(calls.some((call) => call.url.startsWith('/api/storage/auto-backup'))).toBe(false);
  });

  it('shows them with storage.backupAll, and off the Master PC says where they are done', async () => {
    await boot([...ADMIN, 'storage.manage', 'storage.backupAll'], ({ url }) =>
      url === '/api/storage/auto-backup'
        ? json({
            enabled: true,
            folder: 'E:\\Backups',
            time: '21:00',
            keepLast: 7,
            lastRun: null,
            folderReachable: true,
          })
        : undefined,
    );
    await openStorageTab();

    expect(await screen.findByText(t('backupAll.title'))).toBeTruthy();
    expect(screen.getByText(t('backupAll.notMasterPc'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('backupAll.start') })).toBeNull();
    expect(await screen.findByText(t('autoBackup.title'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('autoBackup.save') })).toBeNull();
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
    // On a 720p screen the way out of this one-time screen (and its Save to .txt) must not sit below the fold.
    expect(screen.getByRole('button', { name: t('firstRun.ready.continue') }).parentElement?.style.position).toBe('sticky');
    expect(screen.getByText('master-backup')).toBeTruthy();
    expect(screen.getByText('pair-word')).toBeTruthy();
  });

  it('first run offers Magic restore: a zip by path, its preview, then the restore to the end', async () => {
    const PREVIEW = {
      fileName: 'OrderBook-Backup-shree.zip',
      company: 'Shree Ceramics',
      createdAt: '2026-10-01T15:30:00.000Z',
      appVersion: '1.3.0',
      masterUniqueId: 'MASTER-1',
      counts: { parties: 4, products: 9, users: 3, leads: 12, orders: 5 },
      photos: 7,
      totalBytes: 2048,
      sealed: { secretSettings: 1, connectorCredentials: 0 },
    };
    const job = (phase: string) => ({
      id: 'job-1',
      kind: 'restore',
      phase,
      done: 0,
      total: 0,
      startedAt: '2026-10-03T00:00:00.000Z',
    });
    let started = false;
    const calls = await bootTo(({ url, method }) => {
      if (url === '/api/setup/status') {
        return json({ setupComplete: false, onMasterPc: true, serverMasterSetupNeeded: false });
      }
      if (url === '/api/setup/archive/preview' && method === 'POST') return json(PREVIEW);
      if (url === '/api/setup/archive/restore' && method === 'POST') {
        started = true;
        return json(job('checking'), 202);
      }
      if (url === '/api/setup/archive/job') return json(started ? job('done') : null);
      return undefined;
    });

    fireEvent.click(await screen.findByRole('button', { name: t('firstRun.choose.magicRestore') }));
    // The version 1 restore stays, under its own name.
    expect(screen.queryByRole('button', { name: t('firstRun.choose.restore') })).toBeNull();
    fireEvent.change(screen.getByLabelText(t('magicRestore.pathLabel')), {
      target: { value: 'E:\\OrderBook-Backup-shree.zip' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('magicRestore.read') }));
      await wait(0);
    });

    expect(await screen.findByText('Shree Ceramics')).toBeTruthy();
    expect(calls.find((call) => call.url === '/api/setup/archive/preview')?.body).toEqual({
      path: 'E:\\OrderBook-Backup-shree.zip',
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('magicRestore.start') }));
      await wait(0);
    });
    expect(await screen.findByText(t('magicRestore.doneTitle'))).toBeTruthy();
    expect(calls.find((call) => call.url === '/api/setup/archive/restore')?.body).toEqual({
      path: 'E:\\OrderBook-Backup-shree.zip',
    });
    // One secret setting cannot travel, so the owner is told to enter it again.
    expect(
      screen.getByText(t('backupAll.sealedNotice', { settings: 1, connectors: 0 })),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: t('firstRun.ready.continue') })).toBeTruthy();
  });

  it('first run offers all three forks on the Master PC', async () => {
    await bootTo(({ url }) =>
      url === '/api/setup/status'
        ? json({ setupComplete: false, onMasterPc: true, serverMasterSetupNeeded: false })
        : undefined,
    );

    expect(await screen.findByRole('button', { name: t('firstRun.choose.newSite') })).toBeTruthy();
    expect(screen.getByRole('button', { name: t('firstRun.choose.magicRestore') })).toBeTruthy();
    expect(screen.getByRole('button', { name: t('firstRun.choose.restore') })).toBeTruthy();
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
    expect(screen.queryByRole('button', { name: t('firstRun.choose.magicRestore') })).toBeNull();
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

  it('rings a signed-in Server Master in the footer', async () => {
    await boot(ADMIN, ({ url }) =>
      url === '/api/auth/me'
        ? json({ user: user(ADMIN, 'server_master'), sessionToken: 'session-1' })
        : undefined,
    );

    const footer = document.querySelector('.ob-footer')!;
    expect(footer.querySelector('.ob-avatar[data-highlight="true"]')).not.toBeNull();
  });
});

describe('the link to the Master server, and the bell (1.3)', () => {
  const live = () => sockets.all.filter((socket) => !socket.closed).at(-1);
  const footerSync = () => document.querySelector('.ob-footer-sync')?.textContent ?? '';

  async function socketEvent(event: string, payload?: unknown): Promise<void> {
    await waitFor(() => expect(live()).toBeDefined());
    await act(async () => {
      live()!.emit(event, payload);
      await wait(0);
    });
  }

  const NOTICE = {
    id: 'n-1',
    kind: 'panel.offlineLong',
    params: { panel: 'Front desk' },
    link: { kind: 'panel', id: 'panel-1' },
    createdAt: '2026-10-03T09:00:00.000Z',
    readAt: null,
  };

  it('says it is reconnecting while the socket is down, and re-reads every screen once it is back', async () => {
    const calls = await boot(ADMIN);
    await waitFor(() => expect(gets(calls, '/api/pipelines')).toBeGreaterThan(0));
    const pipelines = gets(calls, '/api/pipelines');
    const me = gets(calls, '/api/auth/me');

    await socketEvent('disconnect', 'transport close');
    expect(footerSync()).toBe(t('master.sync.serverUnreachable'));
    // A dropped transport comes back by itself; nothing to do by hand.
    expect(live()!.connects).toBe(0);

    await socketEvent('connect');
    expect(footerSync()).not.toBe(t('master.sync.serverUnreachable'));
    await waitFor(() => expect(gets(calls, '/api/pipelines')).toBeGreaterThan(pipelines));
    expect(gets(calls, '/api/auth/me')).toBeGreaterThan(me);
  });

  it('connects again after the server closed the socket on purpose', async () => {
    await boot(ADMIN);
    await socketEvent('disconnect', 'io server disconnect');

    await waitFor(() => expect(live()!.connects).toBe(1), { timeout: 3000 });
  });

  it('counts unread notices, and opening one marks it read and goes where it points', async () => {
    const calls = await boot(ADMIN, (call) =>
      call.url.split('?')[0] === '/api/notifications'
        ? json({ items: [NOTICE], unreadCount: 1 })
        : call.url === '/api/notifications/read'
          ? json({ unreadCount: 0 })
          : undefined,
    );
    const bell = await screen.findByRole('button', {
      name: t('notification.unreadLabel', { count: 1 }),
    });

    await act(async () => {
      fireEvent.click(bell);
      await wait(0);
    });
    await act(async () => {
      fireEvent.click(screen.getByText(t('notification.panel.offlineLong', { panel: 'Front desk' })));
      await wait(0);
    });

    expect(calls.find((call) => call.url === '/api/notifications/read')?.body).toEqual({
      ids: ['n-1'],
    });
    await waitFor(() => expect(topbarTitle()).toBe(t('nav.master.panels')));
  });

  it('re-reads the bell when a notice is pushed', async () => {
    const calls = await boot(ADMIN);
    await waitFor(() => expect(gets(calls, '/api/notifications')).toBeGreaterThan(0));
    const before = gets(calls, '/api/notifications');

    await socketEvent('notification:new', { ...NOTICE, forUserId: 'user-1' });

    await waitFor(() => expect(gets(calls, '/api/notifications')).toBeGreaterThan(before));
  });

  it('puts a panel offline over an hour on the Dashboard and the Panels list', async () => {
    await boot(ADMIN);
    const away = {
      id: 'panel-1', name: 'Front desk', deviceCode: 'DSK-1', status: 'active', roleId: null,
      lanIp: null, pairedAt: null, createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z', isConnected: false, runtime: null,
      lastSeenAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    };
    await socketEvent('panels:changed', [away]);
    await summaryArrives({ leadCount: 0 });
    await pressAltDigitUntil(2, t('nav.master.dashboard'));

    const tile = (await screen.findByText(t('dashboard.stat.panelsOfflineLong'))).closest(
      '.ob-stattile',
    ) as HTMLElement;
    expect(within(tile).getByText('1')).toBeTruthy();

    await act(async () => {
      fireEvent.click(tile);
      await wait(0);
    });
    expect(
      await screen.findByText(t('panels.offlineFor', { duration: formatElapsed(2 * 3_600_000) })),
    ).toBeTruthy();
  });

  it('does not count a removed panel as offline', async () => {
    await boot(ADMIN);
    const base = {
      deviceCode: 'DSK', roleId: null, lanIp: null, pairedAt: null, createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z', isConnected: false, runtime: null, lastSeenAt: null,
    };
    await socketEvent('panels:changed', [
      { ...base, id: 'p1', name: 'Front desk', status: 'active' },
      { ...base, id: 'p2', name: 'Old counter', status: 'revoked' },
      { ...base, id: 'p3', name: 'Till', status: 'revoked' },
    ]);
    expect(await screen.findByText(t('master.sync.offline', { count: 1 }))).toBeTruthy();
    expect(screen.queryByText(t('master.sync.offline', { count: 3 }))).toBeNull();
  });
});

describe('the Chatroom (1.3 Phase 6)', () => {
  const live = () => sockets.all.filter((socket) => !socket.closed).at(-1);
  const ROOM = {
    id: 'room-1', kind: 'group', name: 'Dispatch desk', description: null, announceOnly: false,
    archivedAt: null, myRole: 'member', muted: false, lastSeq: 4, lastReadSeq: 1, unread: 3,
    mentionUnread: 0, memberCount: 2, lastMessageAt: '2026-10-03T09:00:00.000Z', lastMessage: null,
    direct: null,
  };

  /** Boots as somebody with `permissions`, answering the chat routes with one room. */
  function bootChat(permissions: string[], extra?: (call: Call) => Response | undefined): Promise<Call[]> {
    return boot(permissions, (call) => {
      const path = call.url.split('?')[0];
      if (path === '/api/chat/rooms') return json([ROOM]);
      if (path === '/api/chat/rooms/room-1') {
        return json({ ...ROOM, members: [], pinned: [] });
      }
      if (path === '/api/chat/rooms/room-1/messages') return json([]);
      if (path === '/api/chat/tasks') return json([]);
      return extra?.(call);
    });
  }

  const row = () => screen.queryByTitle(t('nav.chatroom'));

  it('is a Work row only with chat.use, carrying the unread total', async () => {
    await bootChat(['chat.use']);
    await waitFor(() => expect(row()?.textContent).toContain('3'));
    cleanup();

    await bootChat(['leads.view']);
    expect(row()).toBeNull();
  });

  it('opens on Alt+C, on its first page, Rooms', async () => {
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

  it('does not open on Alt+C without chat.use', async () => {
    await pressAltDigitUntil(1, t('nav.basicHome')).catch(() => undefined);
    await boot(['leads.view']);
    await pressAltDigitUntil(3, t('lead.board.tab.list'));
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', altKey: true, bubbles: true, cancelable: true }),
      );
      await wait(0);
    });
    expect(topbarTitle()).toBe(t('lead.board.tab.list'));
  });

  it('offers Groups as a page only with chat.createGroups or chat.manage', async () => {
    await bootChat(['chat.use']);
    await waitFor(() => expect(row()).not.toBeNull());
    await open(t('nav.chatroom'));
    expect(await screen.findByTitle(t('chat.sub.tasks'))).toBeTruthy();
    expect(screen.queryByTitle(t('chat.sub.groups'))).toBeNull();
    cleanup();

    await bootChat(['chat.use', 'chat.createGroups']);
    await waitFor(() => expect(row()).not.toBeNull());
    await open(t('nav.chatroom'));
    expect(await screen.findByTitle(t('chat.sub.groups'))).toBeTruthy();
  });

  it('reads the rooms again when the Master pushes a chat event', async () => {
    const calls = await bootChat(['chat.use']);
    await waitFor(() => expect(gets(calls, '/api/chat/rooms')).toBeGreaterThan(0));
    const before = gets(calls, '/api/chat/rooms');

    await waitFor(() => expect(live()).toBeDefined());
    await act(async () => {
      live()!.emit('chat:event', { kind: 'room', roomId: 'room-1', forUserId: 'user-1' });
      await wait(700);
    });

    expect(gets(calls, '/api/chat/rooms')).toBeGreaterThan(before);
  });

  it('opens the room a bell entry points at', async () => {
    const calls = await bootChat(['chat.use'], (call) =>
      call.url.split('?')[0] === '/api/notifications'
        ? json({
            items: [
              {
                id: 'n-9', kind: 'chat.mention', params: { name: 'Bina', room: 'Dispatch desk' },
                link: { kind: 'chat', id: 'room-1' }, createdAt: '2026-10-03T09:00:00.000Z', readAt: null,
              },
            ],
            unreadCount: 1,
          })
        : call.url === '/api/notifications/read'
          ? json({ unreadCount: 0 })
          : undefined,
    );

    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: t('notification.unreadLabel', { count: 1 }) }));
      await wait(0);
    });
    await act(async () => {
      fireEvent.click(screen.getByText(t('notification.chat.mention', { name: 'Bina', room: 'Dispatch desk' })));
      await wait(0);
    });

    await waitFor(() => expect(calls.some((call) => call.url === '/api/chat/rooms/room-1')).toBe(true));
    expect(await screen.findByRole('button', { name: t('chat.room.back') })).toBeTruthy();
  });

  describe('Share in chat', () => {
    async function openOrderAs(permissions: string[]) {
      const calls = await openList(permissions, t('nav.orders'), (call) => {
        const path = call.url.split('?')[0];
        if (path === '/api/chat/rooms') return json([ROOM]);
        return undefined;
      });
      fireEvent.click(await screen.findByText(ORDER.id));
      await screen.findByRole('button', { name: t('action.backToList') });
      return calls;
    }

    it('is on a final order only with chat.use and chat.shareRecords, and opens the share sheet', async () => {
      await openOrderAs(['orders.view', 'chat.use']);
      expect(screen.queryByRole('button', { name: t('chat.share.button') })).toBeNull();
      cleanup();

      await openOrderAs(['orders.view', 'chat.use', 'chat.shareRecords']);
      fireEvent.click(screen.getByRole('button', { name: t('chat.share.button') }));

      expect((await screen.findAllByRole('heading', { name: t('chat.share.title') })).length).toBeGreaterThan(0);
      expect(await screen.findByText('Dispatch desk')).toBeTruthy();
      expect(screen.getAllByText(new RegExp(ORDER.id)).length).toBeGreaterThan(0);
    });
  });
});

describe('the Printroom (1.3 Phase 7)', () => {
  const live = () => sockets.all.filter((socket) => !socket.closed).at(-1);
  const JOB = {
    id: 'job-1', kind: 'filling', source: 'lead', sourceId: 'LD0000000001', sourceNumber: 'PO/2026-27/00001',
    partyName: 'Shree Ceramics', copies: 2, note: null, targetStation: null, status: 'queued',
    sender: { id: 'user-2', displayName: 'Bina', avatar: null, tier: 'office' }, requestedFrom: 'lan',
    requestedAt: '2026-10-03T09:00:00.000Z', claimedAt: null, claimedStationName: null, printedBy: null,
    printedAt: null, printerName: null, printedStationName: null, cancelledBy: null, cancelledAt: null,
    hasDocument: true,
  };
  const row = () => screen.queryByTitle(t('nav.printroom'));

  /** Boots as somebody with `permissions`, answering the Printroom routes with one waiting job. */
  function bootPrint(permissions: string[], extra?: (call: Call) => Response | undefined): Promise<Call[]> {
    return boot(permissions, (call) => {
      const path = call.url.split('?')[0];
      const answered = extra?.(call);
      if (answered) return answered;
      if (path === '/api/print-jobs') return json({ jobs: [JOB], nextCursor: null, waitingCount: 3 });
      if (path === '/api/print-stations') return json([]);
      return undefined;
    });
  }

  it('is a Work row only with print.send or print.station, carrying the waiting count', async () => {
    await bootPrint(['print.send']);
    await waitFor(() => expect(row()?.textContent).toContain('3'));
    cleanup();

    await bootPrint(['print.station']);
    await waitFor(() => expect(row()?.textContent).toContain('3'));
    cleanup();

    const calls = await bootPrint(['leads.view']);
    expect(row()).toBeNull();
    // Without either right the shell does not even ask.
    expect(gets(calls, '/api/print-jobs')).toBe(0);
  });

  it('opens on Alt+P, on its first page, Waiting', async () => {
    await bootPrint(['print.station']);
    await waitFor(() => expect(row()).not.toBeNull());

    await waitFor(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', altKey: true, bubbles: true, cancelable: true }),
      );
      expect(topbarTitle()).toBe(t('printroom.filter.waiting'));
    });
    expect(await screen.findByText('Shree Ceramics')).toBeTruthy();
  });

  it('does not open on Alt+P without either right', async () => {
    await boot(['leads.view']);
    await pressAltDigitUntil(3, t('lead.board.tab.list'));
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', altKey: true, bubbles: true, cancelable: true }),
      );
      await wait(0);
    });
    expect(topbarTitle()).toBe(t('lead.board.tab.list'));
  });

  it('offers Waiting, Printed and Sent by me as pages', async () => {
    await bootPrint(['print.send']);
    await waitFor(() => expect(row()).not.toBeNull());
    await open(t('nav.printroom'));
    expect(await screen.findByTitle(t('printroom.filter.printed'))).toBeTruthy();
    expect(screen.getByTitle(t('printroom.filter.mine'))).toBeTruthy();
  });

  it('counts the waiting jobs again when the Master pushes print:changed', async () => {
    const calls = await bootPrint(['print.station']);
    await waitFor(() => expect(gets(calls, '/api/print-jobs')).toBeGreaterThan(0));
    const before = gets(calls, '/api/print-jobs');

    await waitFor(() => expect(live()).toBeDefined());
    await act(async () => {
      live()!.emit('print:changed', { ...JOB, forUserId: 'user-1' });
      await wait(700);
    });

    expect(gets(calls, '/api/print-jobs')).toBeGreaterThan(before);
  });

  it('draws the Dashboard\'s waiting-jobs figure only for somebody with a Printroom right', async () => {
    await bootPrint(['orders.view', 'print.station']);
    await summaryArrives({ openOrderCount: 1 });
    expect(await screen.findByText(t('dashboard.stat.printPending'))).toBeTruthy();
    cleanup();

    await boot(['orders.view']);
    await summaryArrives({ openOrderCount: 1 });
    await screen.findByText(t('dashboard.orders.title'));
    expect(screen.queryByText(t('dashboard.stat.printPending'))).toBeNull();
  });

  it('opens the job a bell entry points at', async () => {
    const calls = await bootPrint(['print.station'], (call) => {
      const path = call.url.split('?')[0];
      if (path === '/api/notifications') {
        return json({
          items: [
            {
              id: 'n-7', kind: 'print.printed', params: { name: 'Desk', party: 'Shree Ceramics' },
              link: { kind: 'print', id: 'job-1' }, createdAt: '2026-10-03T09:00:00.000Z', readAt: null,
            },
          ],
          unreadCount: 1,
        });
      }
      if (call.url === '/api/notifications/read') return json({ unreadCount: 0 });
      if (path === '/api/print-jobs/job-1') return json({ ...JOB, document: null, hasDocument: false });
      return undefined;
    });

    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: t('notification.unreadLabel', { count: 1 }) }));
      await wait(0);
    });
    await act(async () => {
      fireEvent.click(screen.getByText(t('notification.print.printed', { name: 'Desk', party: 'Shree Ceramics' })));
      await wait(0);
    });

    await waitFor(() => expect(calls.some((call) => call.url === '/api/print-jobs/job-1')).toBe(true));
    expect(await screen.findByRole('button', { name: t('action.backToList') })).toBeTruthy();
  });

  describe('Send to Printroom from a pending order\'s note', () => {
    async function openNote(permissions: string[]) {
      const calls = await openList(permissions, t('nav.leads'), (call) => {
        const path = call.url.split('?')[0];
        if (path === '/api/print-jobs' && call.method === 'POST') return json({ id: 'sent' }, 201);
        if (path === '/api/print-jobs') return json({ jobs: [], nextCursor: null, waitingCount: 0 });
        if (path === '/api/print-stations') return json([]);
        return undefined;
      });
      fireEvent.click(await screen.findByText(LEAD.id));
      fireEvent.click(await screen.findByRole('button', { name: t('orderNote.filling') }));
      await screen.findByLabelText(t('orderNote.copies'));
      return calls;
    }

    it('is offered only with print.send', async () => {
      await openNote(['leads.view', 'leads.export', 'parties.view']);
      expect(screen.queryByRole('button', { name: t('orderNote.sendToPrintroom') })).toBeNull();
      cleanup();

      await openNote(['leads.view', 'leads.export', 'parties.view', 'print.send']);
      expect(screen.getByRole('button', { name: t('orderNote.sendToPrintroom') })).toBeTruthy();
    });

    it('posts the pending order to /api/print-jobs with its copies and a request id', async () => {
      const calls = await openNote(['leads.view', 'leads.export', 'parties.view', 'print.send']);
      fireEvent.change(screen.getByLabelText(t('orderNote.copies')), { target: { value: '3' } });
      fireEvent.click(screen.getByRole('button', { name: t('orderNote.sendToPrintroom') }));

      const dialog = await screen.findByRole('dialog');
      fireEvent.click(within(dialog).getByRole('button', { name: t('printroom.dialog.send') }));

      await waitFor(() => expect(calls.some((call) => call.method === 'POST' && call.url === '/api/print-jobs')).toBe(true));
      const post = calls.find((call) => call.method === 'POST' && call.url === '/api/print-jobs')!;
      expect(post.body).toMatchObject({ kind: 'filling', source: 'lead', sourceId: LEAD.id, copies: 3 });
      expect((post.body as { requestId: string }).requestId).toMatch(/^[0-9a-f]{32}$/);
    });
  });
});

describe('the faces on the Pending and Final lists (R22)', () => {
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
  const live = () => sockets.all.filter((socket) => !socket.closed).at(-1);

  for (const [kind, label, rowId] of [
    ['lead', t('nav.leads'), LEAD.id],
    ['order', t('nav.orders'), ORDER.id],
  ] as const) {
    it(`shows who has a ${kind} open on its row: the first read, then the Master's pushes`, async () => {
      const calls = await openList(ADMIN, label, ({ url }) =>
        url === `/api/presence/board?kind=${kind}`
          ? json(board(kind, rowId, [face('user-9', 'Ravi Kumar', true)]))
          : undefined,
      );
      expect(await screen.findByTitle(t('presence.editing', { name: 'Ravi Kumar' }))).toBeTruthy();
      expect(calls.some((call) => call.url === `/api/presence/board?kind=${kind}`)).toBe(true);

      // A push is the whole board: the new face replaces the old.
      await waitFor(() => expect(live()).toBeDefined());
      await act(async () => {
        live()!.emit('presence:board', { ...board(kind, rowId, [face('user-8', 'Meera', false)]), forUserId: 'user-1' });
        await wait(0);
      });
      expect(await screen.findByTitle(t('presence.viewing', { name: 'Meera' }))).toBeTruthy();
      expect(screen.queryByTitle(t('presence.editing', { name: 'Ravi Kumar' }))).toBeNull();

      // The other board's push is not this one's.
      const other = kind === 'lead' ? 'order' : 'lead';
      await act(async () => {
        live()!.emit('presence:board', { ...board(other, rowId, []), forUserId: 'user-1' });
        await wait(0);
      });
      expect(screen.getByTitle(t('presence.viewing', { name: 'Meera' }))).toBeTruthy();

      await act(async () => {
        live()!.emit('presence:board', { ...board(kind, rowId, []), forUserId: 'user-1' });
        await wait(0);
      });
      expect(screen.queryByTitle(t('presence.viewing', { name: 'Meera' }))).toBeNull();
    });
  }
});

describe('Assigning and editing roles (1.4.3)', () => {
  const SYNC = { version: 1, hlc: 'h', fieldHlc: {}, temporaryId: null };
  const stamp = { createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' };
  const ROLE_A = {
    id: 'role-a', tenantId: 't', name: 'Packer', tier: 'office', permissions: ['leads.view'],
    isSystem: false, userCount: 1, deletedAt: null, ...stamp, sync: SYNC,
  };
  const ROLE_B = {
    id: 'role-b', tenantId: 't', name: 'Dispatcher', tier: 'management',
    permissions: ['leads.view', 'leads.edit', 'orders.view', 'orders.edit', 'lead.convert'],
    isSystem: false, userCount: 0, deletedAt: null, ...stamp, sync: SYNC,
  };
  const PERSON = {
    id: 'user-7', tenantId: 't', username: 'meera', displayName: 'Meera', roleId: 'role-a',
    roleName: 'Packer', roleTier: 'office', isActive: true, lastSignInAt: null, avatar: null,
    deletedAt: null, ...stamp, sync: SYNC,
  };
  const PERMS = [...ADMIN, 'roles.assign', 'roles.edit', 'users.manage'];

  async function openAccess(extra?: (call: Call) => Response | undefined): Promise<Call[]> {
    const calls = await boot(PERMS, (call) => {
      const path = call.url.split('?')[0];
      if (path === '/api/access/users' && call.method === 'GET') return json([PERSON]);
      if (path === '/api/access/roles' && call.method === 'GET') return json([ROLE_A, ROLE_B]);
      if (path === '/api/access/permission-catalogue') return json(buildPermissionCatalogue());
      if (path === '/api/access/roles/role-b') return json(ROLE_B);
      return extra?.(call);
    });
    await open(t('nav.master.access'));
    return calls;
  }

  it('shows what each role allows on its card, and changes nothing until the change is confirmed', async () => {
    const calls = await openAccess((call) =>
      call.method === 'PUT' && call.url === '/api/access/users/user-7'
        ? json({ ...PERSON, roleId: 'role-b', roleName: 'Dispatcher', roleTier: 'management' })
        : undefined,
    );

    fireEvent.click(await screen.findByTitle(t('access.tab.users')));
    fireEvent.click((await screen.findAllByText('Meera'))[0]!);
    const group = await screen.findByRole('radiogroup', { name: t('access.users.colRole') });

    // The card for Dispatcher says how much it grants, and what it can change.
    const card = within(group).getByText('Dispatcher').closest('label')!;
    expect(card.textContent).toContain(t('access.rolePicker.changes'));
    expect(card.textContent).toMatch(/Pending Orders/);
    expect(within(group).getByText(t('access.rolePicker.current'))).toBeTruthy();

    // Choosing a card saves nothing: the old drop-down saved on the first click.
    fireEvent.click(within(card).getByRole('radio'));
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: t('access.users.roleChangeApply') }));
    const dialog = await screen.findByRole('dialog');
    // Four keys gained (Packer holds one of Dispatcher's five), none lost.
    expect(dialog.textContent).toContain('Meera');
    expect(dialog.textContent).toContain('Permissions gained: 4. Permissions lost: 0.');
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);

    fireEvent.click(within(dialog).getByRole('button', { name: t('access.users.roleChangeApply') }));
    await waitFor(() =>
      expect(
        calls.find((call) => call.method === 'PUT' && call.url === '/api/access/users/user-7')?.body,
      ).toMatchObject({ roleId: 'role-b' }),
    );
  });

  it('puts party creation and editing in plain view on an office role, and a card says what a role holds for parties', async () => {
    await openAccess((call) =>
      call.url === '/api/access/roles/role-a' ? json({ ...ROLE_A, permissions: ['leads.view', 'parties.view', 'parties.create'] }) : undefined,
    );

    fireEvent.click(await screen.findByTitle(t('access.tab.roles')));
    fireEvent.click(await screen.findByText('Packer'));
    fireEvent.click(await screen.findByRole('button', { name: t('access.roles.edit') }));

    // The two rights sit in a card of their own, above the full grid.
    const create = await screen.findByRole('checkbox', { name: new RegExp(`^${t('access.roleEditor.partiesCreate')}`) });
    const edit = screen.getByRole('checkbox', { name: new RegExp(`^${t('access.roleEditor.partiesEdit')}`) });
    expect((create as HTMLInputElement).checked).toBe(true);
    expect((edit as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText(t('access.roleEditor.partiesCreateHint'))).toBeTruthy();

    // Ticking one dirties the draft and holds the same key the grid below holds.
    fireEvent.click(edit);
    expect(screen.getByText(`● ${t('access.roleEditor.unsaved')}`)).toBeTruthy();
    expect((screen.getByLabelText('Parties — Edit') as HTMLInputElement).checked).toBe(true);
  });

  it('offers "Change role" only for a different role', async () => {
    await openAccess();
    fireEvent.click(await screen.findByTitle(t('access.tab.users')));
    fireEvent.click((await screen.findAllByText('Meera'))[0]!);
    await screen.findByRole('radiogroup', { name: t('access.users.colRole') });
    const apply = screen.getByRole('button', { name: t('access.users.roleChangeApply') });
    expect((apply as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(t('access.users.roleChangeUnchanged'))).toBeTruthy();
  });

  it('role editor: search narrows the permissions, an edit shows the unsaved marker, and closing asks in a themed dialog', async () => {
    const nativeConfirm = vi.fn(() => true);
    vi.stubGlobal('confirm', nativeConfirm);
    await openAccess();

    fireEvent.click(await screen.findByTitle(t('access.tab.roles')));
    fireEvent.click(await screen.findByText('Dispatcher'));
    fireEvent.click(await screen.findByRole('button', { name: t('access.roles.edit') }));

    const search = await screen.findByLabelText(t('access.roleEditor.searchLabel'));
    expect(screen.getByText(t('access.roleEditor.noChanges'))).toBeTruthy();
    expect(screen.getAllByRole('checkbox').length).toBeGreaterThan(10);

    fireEvent.change(search, { target: { value: 'convert' } });
    const shown = screen.getAllByRole('checkbox');
    expect(shown.length).toBeLessThan(10);
    expect(screen.getByText(t('permission.lead.convert'))).toBeTruthy();

    fireEvent.change(search, { target: { value: 'zzzz-nothing' } });
    expect(screen.getByText(t('access.roleEditor.searchNone', { query: 'zzzz-nothing' }))).toBeTruthy();
    fireEvent.change(search, { target: { value: '' } });

    fireEvent.change(screen.getByLabelText(t('access.roleEditor.nameLabel')), {
      target: { value: 'Dispatcher 2' },
    });
    expect(screen.getByText(`● ${t('access.roleEditor.unsaved')}`)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: t('access.roleEditor.cancel') }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain(t('access.roleEditor.discardTitle'));
    expect(nativeConfirm).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: t('access.roleEditor.discardKeep') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByLabelText(t('access.roleEditor.nameLabel'))).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: t('access.roleEditor.cancel') }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: t('access.roleEditor.discardConfirmButton'),
      }),
    );
    await waitFor(() => expect(screen.queryByLabelText(t('access.roleEditor.nameLabel'))).toBeNull());
    expect(nativeConfirm).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('Notice board in the sidebar and in roles (Oct 7)', () => {
  const NOTICE_PERMS = [...ADMIN, 'notices.view'];

  it('offers the Notice board with notices.view and management only with notices.manage', async () => {
    await boot(NOTICE_PERMS);
    expect(screen.getByTitle(t('nav.notices'))).toBeTruthy();
    expect(screen.queryByTitle(t('nav.noticesManage'))).toBeNull();
  });

  it('offers neither without the permissions: the rows are absent, not greyed', async () => {
    await boot(ADMIN);
    expect(screen.queryByTitle(t('nav.notices'))).toBeNull();
    expect(screen.queryByTitle(t('nav.noticesManage'))).toBeNull();
  });

  it('offers Notice board management to a manager, in the Admin group after Roles & users', async () => {
    await boot([...NOTICE_PERMS, 'notices.manage', 'roles.view', 'roles.edit', 'roles.create']);
    const manage = screen.getByTitle(t('nav.noticesManage'));
    expect(manage).toBeTruthy();
    const labels = [...document.querySelectorAll('.ob-navitem-main')].map((row) => row.getAttribute('title'));
    expect(labels.indexOf(t('nav.noticesManage'))).toBe(labels.indexOf(t('nav.master.access')) + 1);
  });

  it('is reached by Alt+N and Alt+M only where the sidebar offers it', async () => {
    await boot(NOTICE_PERMS);
    const alt = (letter: string) =>
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: letter,
          code: `Key${letter.toUpperCase()}`,
          altKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    await waitFor(() => {
      alt('n');
      expect(topbarTitle()).toBe(t('nav.notices'));
    });
    // Not offered without notices.manage: the chord leaves the screen where it was.
    await act(async () => {
      alt('m');
      await wait(0);
    });
    expect(topbarTitle()).toBe(t('nav.notices'));
  });
});

describe('Notices in the role cards and the role editor (Oct 7)', () => {
  const SYNC = { version: 1, hlc: 'h', fieldHlc: {}, temporaryId: null };
  const stamp = { createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' };
  const role = (id: string, name: string, tier: string, permissions: string[]) => ({
    id, tenantId: 't', name, tier, permissions, isSystem: false, userCount: 0, deletedAt: null, ...stamp, sync: SYNC,
  });
  const READER = role('role-r', 'Reader', 'office', ['leads.view', 'notices.view']);
  const EDITOR = role('role-e', 'Editor', 'admin', ['leads.view', 'notices.view', 'notices.manage']);
  const PERSON = {
    id: 'user-9', tenantId: 't', username: 'dev', displayName: 'Dev', roleId: 'role-r', roleName: 'Reader',
    roleTier: 'office', isActive: true, lastSignInAt: null, avatar: null, deletedAt: null, ...stamp, sync: SYNC,
  };
  const PERMS = [...ADMIN, 'roles.assign', 'roles.edit', 'users.manage'];

  async function openAccess(): Promise<Call[]> {
    const calls = await boot([...PERMS, 'roles.create'], ({ url, method }) => {
      const path = url.split('?')[0];
      if (path === '/api/access/users' && method === 'GET') return json([PERSON]);
      if (path === '/api/access/roles' && method === 'GET') return json([READER, EDITOR]);
      if (path === '/api/access/permission-catalogue') return json(buildPermissionCatalogue());
      if (path === '/api/access/roles/role-r') return json(READER);
      if (path === '/api/access/roles' && method === 'POST') return json(READER, 201);
      return undefined;
    });
    await open(t('nav.master.access'));
    return calls;
  }

  it('says on each role card whether the role reads or also manages the notice board', async () => {
    await openAccess();
    fireEvent.click(await screen.findByTitle(t('access.tab.users')));
    fireEvent.click((await screen.findAllByText('Dev'))[0]!);
    const group = await screen.findByRole('radiogroup', { name: t('access.users.colRole') });

    const line = (name: string) => within(group).getByText(name).closest('label')!.textContent ?? '';
    expect(line('Reader')).toContain(`${t('access.rolePicker.notices')} ${t('access.rolePicker.noticesRead')}`);
    expect(line('Editor')).toContain(`${t('access.rolePicker.notices')} ${t('access.rolePicker.noticesManage')}`);
  });

  it('starts a new role holding the notice board, and sends noticeBoard: false only when it is unticked', async () => {
    for (const untick of [false, true]) {
      const calls = await openAccess();
      fireEvent.click(await screen.findByTitle(t('access.tab.roles')));
      fireEvent.click(await screen.findByRole('button', { name: t('access.roles.create') }));

      const read = (await screen.findAllByRole('checkbox', {
        name: new RegExp(`^${t('permission.notices.view')}`),
      }))[0] as HTMLInputElement;
      expect(read.checked).toBe(true);
      // Ticked by default is not a change: the form is still untouched.
      expect(screen.getByText(t('access.roleEditor.noChanges'))).toBeTruthy();

      if (untick) fireEvent.click(read);
      fireEvent.change(screen.getByLabelText(t('access.roleEditor.nameLabel')), { target: { value: 'Counter' } });
      fireEvent.click(screen.getByRole('button', { name: t('access.roleEditor.save') }));

      await waitFor(() => expect(calls.some((call) => call.method === 'POST' && call.url === '/api/access/roles')).toBe(true));
      const body = calls.find((call) => call.method === 'POST' && call.url === '/api/access/roles')!.body as {
        noticeBoard?: boolean;
        permissions: string[];
      };
      expect(body.noticeBoard).toBe(!untick);
      expect(body.permissions.includes('notices.view')).toBe(!untick);
      cleanup();
    }
  });

  it('puts the notice board rights in a card of their own in the role editor, the admin one locked on an office role', async () => {
    await openAccess();
    fireEvent.click(await screen.findByTitle(t('access.tab.roles')));
    fireEvent.click(await screen.findByText('Reader'));
    fireEvent.click(await screen.findByRole('button', { name: t('access.roles.edit') }));

    await screen.findByLabelText(t('access.roleEditor.searchLabel'));
    // The grid's own group heading reads the same, so the card is told apart by its help text.
    expect(screen.getByText(t('access.roleEditor.noticesHelp'))).toBeTruthy();
    // The card comes first; the grid below repeats the same keys.
    const read = screen.getAllByRole('checkbox', { name: new RegExp(`^${t('permission.notices.view')}`) })[0] as HTMLInputElement;
    const manage = screen.getAllByRole('checkbox', { name: new RegExp(`^${t('permission.notices.manage')}`) })[0] as HTMLInputElement;
    expect(read.checked).toBe(true);
    expect(read.disabled).toBe(false);
    // `notices.manage` is admin tier: an office role cannot hold it, and the card says why.
    expect(manage.checked).toBe(false);
    expect(manage.disabled).toBe(true);
    expect(screen.getAllByText(t('access.permissions.blocked', { tier: t('tier.admin') })).length).toBeGreaterThan(0);

    fireEvent.click(read);
    expect(screen.getByText(`● ${t('access.roleEditor.unsaved')}`)).toBeTruthy();
  });
});

describe('Notice board screens in the Master shell (Oct 7)', () => {
  const NOTICE = {
    id: 'n-1', tenantId: 't', title: 'Godown closed on Friday', body: 'No dispatches on Friday.',
    priority: 'important', pinned: true, showUntil: null, audience: { all: true, roleIds: [] },
    authorId: 'user-1', authorName: 'Owner', createdAt: '2026-10-07T04:00:00.000Z',
    updatedAt: '2026-10-07T04:00:00.000Z', version: 1, readByMe: false,
  };
  const PERMS = [...ADMIN, 'notices.view', 'notices.manage'];

  function noticeRoutes(calls: { n: number }) {
    return ({ url, method }: Call): Response | undefined => {
      const path = url.split('?')[0];
      if (path === '/api/notices' && method === 'GET') {
        calls.n += 1;
        return json({ notices: [NOTICE], unreadCount: 3 });
      }
      if (path === '/api/notices/manage') return json([{ ...NOTICE, expired: false, readCount: 0, audienceSize: 4 }]);
      if (path === '/api/notices/audiences') return json([]);
      return undefined;
    };
  }

  it('puts the unread count on the sidebar row before the board has ever been opened', async () => {
    await boot(PERMS, noticeRoutes({ n: 0 }));
    const row = (await screen.findByTitle(t('nav.notices'))).closest('.ob-navitem');
    await waitFor(() => expect(row?.querySelector('.count')?.textContent).toBe('3'));
  });

  it('opens the board on its row and shows the notices meant for the person', async () => {
    await boot(PERMS, noticeRoutes({ n: 0 }));
    await open(t('nav.notices'));
    expect(topbarTitle()).toBe(t('nav.notices'));
    // The Dashboard card behind it carries the title too; the board's own button tells them apart.
    expect(await screen.findByRole('button', { name: t('notices.board.markAllRead') })).toBeTruthy();
  });

  /** An office-tier sign-in, which lands on Basic Home. */
  const asOffice = (permissions: string[], inner = noticeRoutes({ n: 0 })) => ({ url, method, body }: Call) =>
    url === '/api/auth/me'
      ? json({ user: user(permissions, 'office'), sessionToken: 'session-1' })
      : inner({ url, method, body });

  it('turns over the important and pinned notices above Basic Home, for the roles that land there', async () => {
    await boot(['notices.view'], asOffice(['notices.view']));
    expect(topbarTitle()).toBe(t('nav.basicHome'));
    // The unread important notice also pops up on sign-in (V6); Later leaves the card to be seen.
    fireEvent.click(await screen.findByRole('button', { name: t('notices.signIn.later') }));
    expect(await screen.findByText('Godown closed on Friday')).toBeTruthy();
    // Owner add-on V5: the slideshow, and a slide opens its notice on the board.
    const band = screen.getByRole('region', { name: t('notices.slideshow.label') });
    fireEvent.click(within(band).getByText('Godown closed on Friday'));
    await waitFor(() => expect(topbarTitle()).toBe(t('nav.notices')));
  });

  it('draws no notice card on Basic Home without notices.view', async () => {
    await boot([], asOffice([]));
    expect(topbarTitle()).toBe(t('nav.basicHome'));
    expect(screen.queryByText('Godown closed on Friday')).toBeNull();
  });

  it('opens the management screen from its row, for a manager', async () => {
    await boot(PERMS, noticeRoutes({ n: 0 }));
    await open(t('nav.noticesManage'));
    expect(topbarTitle()).toBe(t('nav.noticesManage'));
    // The topbar title carries the same words; the screen's own button proves it is mounted.
    expect(await screen.findByRole('button', { name: t('notices.manage.new') })).toBeTruthy();
  });

  it('re-reads the board when another administrator changes a notice', async () => {
    const counter = { n: 0 };
    await boot(PERMS, noticeRoutes(counter));
    await open(t('nav.notices'));
    await screen.findByRole('button', { name: t('notices.board.markAllRead') });
    const before = counter.n;
    await changed('notice');
    await waitFor(() => expect(counter.n).toBeGreaterThan(before));
  });
});

describe('V6: important notices pop up on sign-in', () => {
  const IMPORTANT = {
    id: 'NT1', tenantId: 'tenant-1', title: 'Office closed Friday', body: 'Holiday.', priority: 'important',
    pinned: false, showUntil: null, audience: { kind: 'all' }, authorId: null, authorName: null,
    createdAt: '2026-10-05T09:00:00.000Z', updatedAt: '2026-10-05T09:00:00.000Z', version: 1, readByMe: false,
  };
  const withNotice = (call: Call) =>
    call.url.split('?')[0] === '/api/notices' && call.method !== 'POST'
      ? json({ notices: [IMPORTANT], unreadCount: 1 })
      : call.url === '/api/notices/read'
        ? json({ unreadCount: 0 })
        : undefined;
  const popUp = () => screen.queryByRole('dialog', { name: t('notices.signIn.title') });

  it('lists the unread important notice after sign-in, and Mark as read posts it and closes', async () => {
    const calls = await boot([...ADMIN, 'notices.view'], withNotice);
    await waitFor(() => expect(popUp()).not.toBeNull());
    expect(within(popUp()!).getByText('Office closed Friday')).toBeTruthy();

    await act(async () => {
      fireEvent.click(within(popUp()!).getByRole('button', { name: t('notices.signIn.markRead') }));
      await wait(0);
    });

    expect(calls.find((call) => call.url === '/api/notices/read')?.body).toEqual({ ids: ['NT1'] });
    expect(popUp()).toBeNull();
  });

  it('never shows to somebody without notices.view, and does not even ask', async () => {
    const calls = await boot(ADMIN, withNotice);
    await wait(50);
    expect(popUp()).toBeNull();
    expect(calls.some((call) => call.url.split('?')[0] === '/api/notices')).toBe(false);
  });
});
