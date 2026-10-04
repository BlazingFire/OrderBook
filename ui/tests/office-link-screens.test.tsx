/**
 * The Office Panel's screens before anybody is signed in, booted whole in jsdom
 * (`panel-harness.ts`), because what they pin lives in the shell:
 *
 *  · the link's state keeps updating on the sign-in screen (it used to be read once,
 *    so a pairing that had just succeeded still said "Master not reachable");
 *  · a Master removing this PC shows at once, with the reason, instead of after a reload;
 *  · after pairing, the first sync is shown, then the sign-in screen;
 *  · a PC whose Master does not recognise it, or is gone, has a way out.
 */

import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { t } from '../src/i18n.js';
import { installBrowserStubs, json, loadApp, routeFetch, type Call } from './panel-harness.js';

const PAIRED = {
  hasNetworkLink: true,
  interfaces: [{ name: 'eth0', address: '192.168.1.20', broadcastAddress: '192.168.1.255' }],
  isPaired: true,
  panelName: 'Counter',
  state: 'connected',
  masterHost: '10.0.0.1',
  masterPort: 4100,
  companyName: 'Acme Ceramics',
  lastError: null,
  lastSyncedAt: '2026-10-04T10:00:00.000Z',
  masterVersion: '1.4.1',
  catchingUp: false,
  removedByMaster: null,
  unsentChanges: 0,
};

const UNPAIRED = {
  ...PAIRED,
  isPaired: false,
  state: 'unpaired',
  masterHost: null,
  masterPort: null,
  companyName: null,
  lastSyncedAt: null,
  masterVersion: null,
};

/** What `GET /api/connection` answers right now; a test changes it to move the link on. */
let link: Record<string, unknown>;

beforeEach(() => {
  installBrowserStubs();
  vi.stubGlobal('__APP_VERSION__', '1.4.1');
  link = { ...PAIRED };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function boot(route?: (call: Call) => Response | undefined): Promise<Call[]> {
  const calls = routeFetch((call) => {
    const answer = route?.(call);
    if (answer) return answer;
    const path = call.url.split('?')[0] ?? call.url;
    if (path === '/api/connection') return json(link);
    if (path === '/api/session') return json({ session: null, defaultLocale: 'en' });
    if (path === '/api/profiles') return json([]);
    if (path === '/api/storage/path') return json({ dataDir: 'C:\\data', freeBytes: 1e9 });
    return undefined;
  });

  const App = await loadApp('office');
  render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  return calls;
}

const offlineNotice = () => screen.queryByText(t('signin.offlineNotice'));
const company = 'Acme Ceramics';

describe('the link state on the sign-in screen', () => {
  it('does not say the Master is unreachable while it is still being reached, and follows the link as it moves', async () => {
    link = { ...PAIRED, state: 'connecting', lastSyncedAt: null };
    await boot();

    // Connecting is not "not reachable".
    expect(
      await screen.findByText(
        t('connection.setup.connecting', { company }),
        {},
        { timeout: 10_000 },
      ),
    ).toBeTruthy();
    expect(offlineNotice()).toBeNull();

    // The link fails: now it is said.
    link = { ...PAIRED, state: 'disconnected', lastError: 'websocket error' };
    expect(await screen.findByText(t('signin.offlineNotice'), {}, { timeout: 6000 })).toBeTruthy();

    // And comes back: the line goes, without a reload.
    link = { ...PAIRED, state: 'connected' };
    await waitFor(() => expect(offlineNotice()).toBeNull(), { timeout: 6000 });
  });

  it('a Master that does not recognise this PC is said so here, with a way out', async () => {
    link = { ...PAIRED, state: 'disconnected', notRecognised: true };
    await boot();

    expect(
      await screen.findByText(
        t('office.link.notRecognised', { host: '10.0.0.1' }),
        {},
        { timeout: 10_000 },
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: t('connection.unpair.action') })).toBeTruthy();
  });
});

describe('the Master removed this PC', () => {
  it('shows the pairing screen at once with the reason, not after a reload', async () => {
    await boot();
    // Connected and recognised: the sign-in screen, and no way out (that needs somebody who manages panels).
    await screen.findByRole('button', { name: t('signin.submit') }, { timeout: 10_000 });
    expect(screen.queryByRole('button', { name: t('connection.unpair.action') })).toBeNull();

    link = {
      ...UNPAIRED,
      removedByMaster: {
        at: '2026-10-04T09:30:00.000Z',
        companyName: company,
        masterUniqueId: 'm1',
        host: '10.0.0.1',
        port: 4100,
      },
    };

    const alert = await screen.findByText(t('connection.removed.title'), {}, { timeout: 6000 });
    expect(alert.closest('[role="alert"]')?.textContent).toContain(company);
    expect(screen.getByRole('heading', { name: t('connection.title') })).toBeTruthy();
  });
});

describe('after pairing', () => {
  it('shows the first sync, with what to read, and carries on to sign-in when told', async () => {
    link = { ...UNPAIRED };
    await boot((call) => {
      if (call.url === '/api/connection/pair/manual') {
        // The pairing succeeded: the server now reports a paired panel still connecting.
        link = { ...PAIRED, state: 'connecting', lastSyncedAt: null, masterVersion: null };
        return json({ ok: true, companyName: company, newMaster: true, parkedChanges: 2 }, 201);
      }
      return undefined;
    });

    fireEvent.click(
      await screen.findByRole('button', { name: t('connection.mode.manual') }, { timeout: 10_000 }),
    );
    fireEvent.change(screen.getByLabelText(t('connection.manual.address')), {
      target: { value: '10.0.0.1' },
    });
    fireEvent.change(screen.getByLabelText(t('connection.manual.password')), {
      target: { value: 'pw' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('connection.manual.connect') }));

    // Not the sign-in form with a stale warning: the set-up screen, saying what is under way.
    expect(await screen.findByRole('heading', { name: t('connection.setup.title') })).toBeTruthy();
    expect(screen.getByText(t('connection.setup.newMaster'))).toBeTruthy();
    expect(screen.getByText(t('connection.setup.parked', { count: 2 }))).toBeTruthy();
    expect(offlineNotice()).toBeNull();

    // The data arrives, as the link's own status reports it.
    link = { ...PAIRED, state: 'connected', catchingUp: false };
    await waitFor(
      () => expect(screen.getByText(t('connection.setup.ready', { company }))).toBeTruthy(),
      { timeout: 6000 },
    );

    // There was something to read, so it waits to be told.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('connection.setup.continue') }));
    });
    expect(await screen.findByLabelText(t('signin.username'), {}, { timeout: 5000 })).toBeTruthy();
    expect(offlineNotice()).toBeNull();
  });
});
