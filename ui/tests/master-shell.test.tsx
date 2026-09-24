/**
 * The Master Panel's shell, booted whole in jsdom (`panel-harness.ts` says
 * how; the live socket is the one extra edge replaced here). What it pins:
 *
 *  · the footer's "Design system" link keeps the gallery open;
 *  · Alt+N reaches only what the sidebar offers — with the desktop menu's
 *    Developer entry still opening Settings for anybody, as it always has;
 *  · a change another administrator makes reaches the screens built from it:
 *    people and roles on Roles & users, a catalogue import on Inventory and on
 *    Leads & orders, a field value or definition in the Recycle Bin, and a
 *    stage edit in Leads & orders' stage picker.
 */

import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { t } from '../src/i18n.js';
import {
  installBrowserStubs,
  json,
  loadApp,
  pressAltDigit,
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

async function boot(permissions: string[]): Promise<Call[]> {
  const calls = routeFetch(({ url }) => {
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

/** Another administrator's write, as the Master's hub broadcasts it. */
async function changed(entity: string): Promise<void> {
  const live = sockets.all.filter((socket) => !socket.closed).at(-1);
  await act(async () => {
    live?.emit('data:changed', { entity, action: 'updated', id: 'x', payload: null });
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
    // Alt+6 is Office panels, which needs `panels.manage`.
    await boot(['leads.view']);

    await act(async () => pressAltDigit(6));

    expect(topbarTitle()).toBe(t('nav.master.dashboard'));
  });

  it('opens a screen the sidebar does offer', async () => {
    await boot(ADMIN);

    await act(async () => pressAltDigit(6));

    expect(topbarTitle()).toBe(t('nav.master.panels'));
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

    await act(async () => {
      menu?.('settings.developer');
      await wait(0);
    });

    expect(screen.getByRole('tab', { name: t('settings.tab.developer') })).toBeTruthy();
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
