/**
 * The Master Panel's shell, booted whole in jsdom (`panel-harness.ts` says
 * how; the live socket is the one extra edge replaced here). What it pins:
 *
 *  · the footer's "Design system" link keeps the gallery open;
 *  · Alt+N reaches only what the sidebar offers — with the desktop menu's
 *    Developer entry still opening Settings for anybody, as it always has;
 *  · the screen somebody was on does not outlive their session: whoever signs
 *    in next at that window starts on the Dashboard, not on a screen the
 *    sidebar does not offer them;
 *  · a Master whose server cannot be reached says so on the splash, rather
 *    than "Request cancelled" in English;
 *  · a change another administrator makes reaches the screens built from it:
 *    people and roles on Roles & users, a catalogue import on Inventory and on
 *    Leads & orders, a field value or definition in the Recycle Bin, and a
 *    stage edit in Leads & orders' stage picker.
 */

import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

const ADMIN = [
  'leads.view',
  'orders.view',
  'inventory.view',
  'products.view',
  'roles.view',
  'users.manage',
  'recycleBin.view',
  'leads.delete',
  'fields.manage',
  'panels.manage',
  'settings.manage',
];

function user(permissions: string[]) {
  return {
    id: 'user-1',
    tenantId: 'tenant-1',
    username: 'owner',
    displayName: 'Owner',
    roleId: 'role-1',
    roleName: 'Administrator',
    roleTier: 'admin',
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
    if (path === '/api/stock' || path === '/api/stock/movements') return json([]);
    if (path === '/api/pipelines') return json([]);
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
    // Alt+7 is Office panels, which needs `panels.manage`: the Master's Alt+N
    // follow its sidebar order (`shared/tests/keys-nav-order.test.ts`), Work
    // then Admin, and Conflicts at 6 is offered to everybody.
    await boot(['leads.view']);
    await pressAltDigitUntil(6, t('nav.master.conflicts'));

    await act(async () => pressAltDigit(7));

    expect(topbarTitle()).toBe(t('nav.master.conflicts'));
  });

  it('opens a screen the sidebar does offer', async () => {
    await boot(ADMIN);

    await pressAltDigitUntil(7, t('nav.master.panels'));
  });

  it('leaves the desktop menu’s Developer entry opening Settings for anybody', async () => {
    let menu: ((id: string) => void) | null = null;
    (window as { orderbook?: unknown }).orderbook = {
      onMenuCommand: (handler: (id: string) => void) => {
        menu = handler;
        return () => undefined;
      },
    };
    await boot(['leads.view']);

    // The panel subscribes from an effect that may not have run yet.
    await waitFor(() => expect(menu).not.toBeNull());
    await act(async () => {
      menu!('settings.developer');
      await wait(0);
    });

    expect(await screen.findByRole('tab', { name: t('settings.tab.developer') })).toBeTruthy();
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
    const before = gets(calls, '/api/access/users');
    expect(before).toBeGreaterThan(0);

    await changed('user');

    expect(gets(calls, '/api/access/users')).toBeGreaterThan(before);
  });

  it('Roles & users refetches the roles when one changes', async () => {
    const calls = await boot(ADMIN);
    await open(t('nav.master.access'));
    const before = gets(calls, '/api/access/roles');

    await changed('role');

    expect(gets(calls, '/api/access/roles')).toBeGreaterThan(before);
  });

  it('Inventory refetches after a catalogue import', async () => {
    const calls = await boot(ADMIN);
    await open(t('nav.master.inventory'));
    const before = gets(calls, '/api/stock');
    expect(before).toBeGreaterThan(0);

    await changed('catalog');

    expect(gets(calls, '/api/stock')).toBeGreaterThan(before);
  });

  it('Leads & orders refetches after a catalogue import', async () => {
    const calls = await boot(ADMIN);
    await open(t('nav.master.leadsOrders'));
    const before = gets(calls, '/api/leads');
    expect(before).toBeGreaterThan(0);

    await changed('catalog');

    expect(gets(calls, '/api/leads')).toBeGreaterThan(before);
  });

  it('Leads & orders re-reads the stages when a pipeline changes', async () => {
    const calls = await boot(ADMIN);
    await open(t('nav.master.leadsOrders'));
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
      const before = gets(calls, '/api/recycle-bin');
      expect(before).toBeGreaterThan(0);

      await changed(entity);

      expect(gets(calls, '/api/recycle-bin')).toBeGreaterThan(before);
    },
  );
});
