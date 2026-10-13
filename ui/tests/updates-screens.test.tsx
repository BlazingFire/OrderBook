/**
 * Both panels' App update screens (1.4 R6, R7, R8): Check now, the download
 * bar, the order of Install now (save all, sign out, then the shell), and the
 * Master's nightly-update switch.
 *
 * Each screen is rendered directly over a stubbed `fetch`, with a fake desktop
 * bridge on `window.orderbook`. The shell itself (stopping the server, running
 * the setup) is `electron/tests`; here the question is what the *page* asks of
 * it, and in which order.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentType } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReleaseManifest, UpdateStatusResponse } from '@orderbook/shared';

import { ConfirmProvider } from '../src/ConfirmDialog.js';
import { configureUi } from '../src/config.js';
import { t } from '../src/i18n.js';
import { ToastProvider } from '../src/Toast.js';
import { __resetUnsavedWorkForTests, useUnsavedWork } from '../src/unsavedWork.js';
import { installBrowserStubs, json, routeFetch, type Call } from './panel-harness.js';

const IDLE = {
  phase: 'idle',
  version: null,
  receivedBytes: 0,
  totalBytes: 0,
  percent: 0,
  bytesPerSecond: 0,
  etaSeconds: null,
  error: null,
};

const OFFER = {
  version: '1.3.0',
  file: 'OrderBook-Master-1.3.0-Setup.exe',
  sha256: 'a'.repeat(64),
  sizeBytes: 150 * 1024 * 1024,
  releasedAt: '2026-10-03T00:00:00.000Z',
  panel: 'master',
  platform: 'win32',
} as ReleaseManifest;

function status(changes: Partial<UpdateStatusResponse> = {}): UpdateStatusResponse {
  return {
    running: 'test',
    master: { current: 'test', available: null, reason: 'upToDate' },
    office: { current: '0.0.0', available: null, reason: 'noRelease' },
    download: { master: IDLE, office: IDLE } as UpdateStatusResponse['download'],
    lastCheckedAt: null,
    auto: { enabled: true, time: '23:00', lastRun: null },
    ...changes,
  };
}

interface Bridge {
  applyUpdate: ReturnType<typeof vi.fn>;
  getUpdateRun?: ReturnType<typeof vi.fn>;
  openLogFolder: ReturnType<typeof vi.fn>;
  getShellSettings: ReturnType<typeof vi.fn>;
}

let order: string[];
let bridge: Bridge;

beforeEach(() => {
  installBrowserStubs();
  __resetUnsavedWorkForTests();
  order = [];
  bridge = {
    applyUpdate: vi.fn(async () => {
      order.push('applyUpdate');
      return true;
    }),
    openLogFolder: vi.fn(async () => true),
    getShellSettings: vi.fn(async () => ({ standalone: false, systemPackage: false })),
  };
  (window as unknown as { orderbook: unknown }).orderbook = bridge;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as { orderbook?: unknown }).orderbook;
});

async function loadScreen(panel: 'master' | 'office'): Promise<ComponentType<never>> {
  configureUi({ panel, defaultTheme: 'light', themeStorageKey: 'ob.theme' });
  const path = `../../${panel}/web/src/screens/UpdatesScreen.tsx`;
  const module = (await import(/* @vite-ignore */ path)) as { UpdatesScreen: ComponentType<never> };
  return module.UpdatesScreen;
}

function Unsaved({ save }: { save?: () => Promise<boolean> }) {
  useUnsavedWork('lead', { label: 'Half-filled lead', save });
  return null;
}

function mount(Screen: ComponentType<never>, props: Record<string, unknown>, unsaved = false) {
  const Component = Screen as unknown as ComponentType<Record<string, unknown>>;
  return render(
    <ConfirmProvider>
      <ToastProvider>
        {unsaved ? <Unsaved save={async () => false} /> : null}
        <Component {...props} />
      </ToastProvider>
    </ConfirmProvider>,
  );
}

const calls = (all: Call[], method: string, path: string) =>
  all.filter((call) => call.method === method && call.url.split('?')[0] === path);

describe('the Master update screen', () => {
  const panels = { panels: [], permissions: ['settings.manage'] };

  it('Check now asks the Master to look at GitHub straight away, and says when nothing is newer', async () => {
    const all = routeFetch(({ method, url }) => {
      if (url === '/api/updates/status') return json(status());
      if (url === '/api/updates/check' && method === 'POST') {
        return json(status({ lastCheckedAt: '2026-10-03T10:00:00.000Z' }));
      }
      return undefined;
    });
    mount(await loadScreen('master'), panels);

    fireEvent.click(await screen.findByRole('button', { name: t('updates.checkNow') }));

    await waitFor(() => expect(calls(all, 'POST', '/api/updates/check')).toHaveLength(1));
    expect(await screen.findByText(t('updates.checkedNone'))).toBeTruthy();
  });

  it('shows the download as bytes done of the total, speed and time left', async () => {
    routeFetch(({ url }) => {
      if (url === '/api/updates/status') {
        return json(
          status({
            download: {
              master: {
                phase: 'downloading',
                version: '1.3.0',
                receivedBytes: 30 * 1024 * 1024,
                totalBytes: 150 * 1024 * 1024,
                percent: 20,
                bytesPerSecond: 3 * 1024 * 1024,
                etaSeconds: 40,
                error: null,
              },
              office: IDLE,
            } as UpdateStatusResponse['download'],
          }),
        );
      }
      return undefined;
    });
    mount(await loadScreen('master'), panels);

    expect((await screen.findByTestId('update-progress-figures')).textContent).toBe(
      '30.0 MB of 150 MB · 3.00 MB/s · 40 s left',
    );
  });

  it('opens the log folder through the shell, the one old-menu function with no in-app twin', async () => {
    routeFetch(({ url }) => (url === '/api/updates/status' ? json(status()) : undefined));
    mount(await loadScreen('master'), panels);

    fireEvent.click(await screen.findByRole('button', { name: t('updates.openLogFolder') }));
    expect(bridge.openLogFolder).toHaveBeenCalledTimes(1);
  });

  describe('Install now', () => {
    function boot() {
      return routeFetch(({ method, url }) => {
        if (url === '/api/updates/status') return json(status({ master: { current: 'test', available: OFFER } }));
        if (url === '/api/updates/master/install' && method === 'POST') {
          order.push('prepare');
          return json({ path: 'C:\\x\\setup.exe', manifest: OFFER });
        }
        if (url === '/api/auth/sign-out' && method === 'POST') {
          order.push('signOut');
          return json({});
        }
        return undefined;
      });
    }

    it('prepares the build, signs out, and only then hands over to the shell', async () => {
      boot();
      mount(await loadScreen('master'), panels);

      fireEvent.click(await screen.findByRole('button', { name: t('updates.installNow') }));

      await waitFor(() => expect(bridge.applyUpdate).toHaveBeenCalledTimes(1));
      expect(order).toEqual(['prepare', 'signOut', 'applyUpdate']);
    });

    it('stops, signing nobody out, when somebody has work that cannot be saved and says no', async () => {
      boot();
      mount(await loadScreen('master'), panels, true);

      fireEvent.click(await screen.findByRole('button', { name: t('updates.installNow') }));
      expect(await screen.findByText('Half-filled lead')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: t('common.cancel') }));

      await waitFor(() => expect(order).toEqual(['prepare']));
      expect(bridge.applyUpdate).not.toHaveBeenCalled();
    });

    it('offers a way back to sign-in when the shell refuses', async () => {
      boot();
      bridge.applyUpdate.mockImplementation(async () => false);
      mount(await loadScreen('master'), panels);

      fireEvent.click(await screen.findByRole('button', { name: t('updates.installNow') }));
      // The Updating screen says where it stopped; Close goes back to the screen under it.
      expect(await screen.findByText(t('updates.run.failedTitle'))).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: t('updates.run.close') }));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(await screen.findByRole('button', { name: t('updates.signInAgain') })).toBeTruthy();
      expect(screen.getByText(t('updates.launchRefused'))).toBeTruthy();
    });

    it('covers the panel with the Updating screen: each step in turn, then the hand-over', async () => {
      let release: () => void = () => undefined;
      routeFetch(({ method, url }) => {
        if (url === '/api/updates/status') return json(status({ master: { current: 'test', available: OFFER } }));
        if (url === '/api/updates/master/install' && method === 'POST') {
          return new Promise<Response>((resolve) => {
            release = () => resolve(json({ path: 'C:\\x\\setup.exe', manifest: OFFER }));
          });
        }
        if (url === '/api/auth/sign-out' && method === 'POST') return json({});
        return undefined;
      });
      bridge.getUpdateRun = vi.fn(async () => ({ pending: null, last: null, installSeconds: 95 }));
      mount(await loadScreen('master'), panels);

      fireEvent.click(await screen.findByRole('button', { name: t('updates.installNow') }));
      const dialog = await screen.findByRole('dialog', { name: t('updates.run.title', { version: '1.3.0' }) });
      const states = () =>
        [...dialog.querySelectorAll('li')].map((item) => item.getAttribute('data-state'));
      expect(states()).toEqual(['active', 'pending', 'pending', 'pending', 'pending']);
      expect(dialog.textContent).toContain(t('updates.run.stepOf', { step: 1, total: 5 }));
      // The install's time is the one measured on this PC last time.
      await waitFor(() =>
        expect(dialog.textContent).toContain(t('updates.run.step.installMeasured', { time: '1 min 35 s' })),
      );
      expect(screen.getByTestId('update-run-clock').textContent).toContain(t('updates.run.left', { time: '1 min 35 s' }));

      release();
      expect(await screen.findByRole('status')).toBeTruthy();
      expect(states()).toEqual(['done', 'done', 'done', 'active', 'pending']);
      expect(dialog.textContent).toContain(t('updates.run.handedOver', { version: '1.3.0', time: '1 min 35 s' }));
      expect(bridge.applyUpdate).toHaveBeenCalledTimes(1);
    });
  });

  describe('the nightly update', () => {
    it('is a switch and a time that save together, for somebody who may manage settings', async () => {
      const all = routeFetch(({ method, url }) => {
        if (url === '/api/updates/status') return json(status());
        if (url === '/api/updates/auto' && method === 'PUT') {
          return json({ enabled: false, time: '22:15', lastRun: null });
        }
        return undefined;
      });
      mount(await loadScreen('master'), panels);

      await screen.findByText(t('updates.auto.title'));
      // The time is disabled while the switch is off, so it is set first.
      fireEvent.change(screen.getByLabelText(t('updates.auto.time')), { target: { value: '22:15' } });
      fireEvent.click(screen.getByRole('switch', { name: t('updates.auto.enabled') }));
      fireEvent.click(screen.getByRole('button', { name: t('updates.auto.save') }));

      await waitFor(() => expect(calls(all, 'PUT', '/api/updates/auto')).toHaveLength(1));
      expect(calls(all, 'PUT', '/api/updates/auto')[0]?.body).toEqual({ enabled: false, time: '22:15' });
    });

    it('is not shown to somebody without settings.manage', async () => {
      routeFetch(({ url }) => (url === '/api/updates/status' ? json(status()) : undefined));
      mount(await loadScreen('master'), { panels: [], permissions: [] });

      await screen.findByRole('button', { name: t('updates.checkNow') });
      expect(screen.queryByText(t('updates.auto.title'))).toBeNull();
    });

    it('says what last night did: updated, waiting for approval, or nothing newer', async () => {
      routeFetch(({ url }) =>
        url === '/api/updates/status'
          ? json(
              status({
                running: 'test',
                auto: {
                  enabled: true,
                  time: '23:00',
                  lastRun: { at: '2026-10-02T17:40:00.000Z', outcome: 'installing', version: '1.3.0' },
                },
              }),
            )
          : undefined,
      );
      mount(await loadScreen('master'), panels);

      // 1.3.0 was prepared but this Master still runs `test`: it was not installed.
      expect(await screen.findByText(/^1\.3\.0 was prepared at .* has not been installed/)).toBeTruthy();
    });
  });
});

describe('the Office waiting screen (ahead of its Master)', () => {
  async function loadRequired() {
    configureUi({ panel: 'office', defaultTheme: 'light', themeStorageKey: 'ob.theme' });
    const path = '../../office/web/src/screens/UpdateRequiredScreen.tsx';
    return (await import(/* @vite-ignore */ path)) as {
      UpdateRequiredScreen: ComponentType<Record<string, unknown>>;
      RECHECK_MS: number;
    };
  }
  const connection = { masterVersion: '1.3.0', lastSyncedAt: null };

  it('asks for the Master version again every few seconds, and stops when it is no longer waiting', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const { UpdateRequiredScreen, RECHECK_MS } = await loadRequired();
      const onRecheck = vi.fn();
      const view = render(
        <ConfirmProvider>
          <ToastProvider>
            <UpdateRequiredScreen connection={connection} permissions={[]} onSignOut={vi.fn()} ahead onRecheck={onRecheck} />
          </ToastProvider>
        </ConfirmProvider>,
      );
      expect(onRecheck).not.toHaveBeenCalled();
      vi.advanceTimersByTime(RECHECK_MS * 3 + 10);
      expect(onRecheck).toHaveBeenCalledTimes(3);

      view.unmount();
      vi.advanceTimersByTime(RECHECK_MS * 3);
      expect(onRecheck).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not poll when it is the behind-the-Master screen: that one offers the install instead', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      routeFetch(({ url }) => (url === '/api/updates/available' ? json({ current: 'test', available: null }) : url === '/api/updates/progress' ? json(IDLE) : undefined));
      const { UpdateRequiredScreen, RECHECK_MS } = await loadRequired();
      const onRecheck = vi.fn();
      render(
        <ConfirmProvider>
          <ToastProvider>
            <UpdateRequiredScreen connection={connection} permissions={[]} onSignOut={vi.fn()} onRecheck={onRecheck} />
          </ToastProvider>
        </ConfirmProvider>,
      );
      vi.advanceTimersByTime(RECHECK_MS * 3);
      expect(onRecheck).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the Office update screen', () => {
  const connection = { masterVersion: '1.3.0', lastSyncedAt: null };
  const props = { connection, permissions: ['settings.manage'] };

  it('Check now makes the Master look at GitHub, and the bar follows the download', async () => {
    let progress: unknown = IDLE;
    const all = routeFetch(({ method, url }) => {
      if (url === '/api/updates/available') return json({ current: 'test', available: { ...OFFER, panel: 'office' } });
      if (url === '/api/updates/check' && method === 'POST') {
        return json({ current: 'test', available: { ...OFFER, panel: 'office' } });
      }
      if (url === '/api/updates/progress') return json(progress);
      if (url === '/api/updates/download' && method === 'POST') {
        progress = {
          phase: 'downloading',
          version: '1.3.0',
          receivedBytes: 10 * 1024 * 1024,
          totalBytes: 100 * 1024 * 1024,
          percent: 10,
          bytesPerSecond: 2 * 1024 * 1024,
          etaSeconds: 45,
          error: null,
        };
        return new Promise<Response>(() => undefined);
      }
      return undefined;
    });
    mount(await loadScreen('office'), props);

    fireEvent.click(await screen.findByRole('button', { name: t('updates.checkNow') }));
    await waitFor(() => expect(calls(all, 'POST', '/api/updates/check')).toHaveLength(1));

    fireEvent.click(await screen.findByRole('button', { name: t('updates.installNow') }));
    expect((await screen.findByTestId('update-progress-figures', {}, { timeout: 4000 })).textContent).toBe(
      '10.0 MB of 100 MB · 2.00 MB/s · 45 s left',
    );
  });

  it('prepares, signs out, then hands over to the shell, like the Master', async () => {
    routeFetch(({ method, url }) => {
      if (url === '/api/updates/available') return json({ current: 'test', available: { ...OFFER, panel: 'office' } });
      if (url === '/api/updates/progress') return json(IDLE);
      if (url === '/api/updates/download' && method === 'POST') {
        order.push('download');
        return json({ path: 'C:\\x\\setup.exe', manifest: OFFER });
      }
      if (url === '/api/auth/sign-out' && method === 'POST') {
        order.push('signOut');
        return json({ ok: true });
      }
      return undefined;
    });
    mount(await loadScreen('office'), props);

    fireEvent.click(await screen.findByRole('button', { name: t('updates.installNow') }));
    await waitFor(() => expect(bridge.applyUpdate).toHaveBeenCalledTimes(1));
    expect(order).toEqual(['download', 'signOut', 'applyUpdate']);
  });
});
