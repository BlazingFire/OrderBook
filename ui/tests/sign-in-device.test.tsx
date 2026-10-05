/**
 * The sign-in windows (R6, R7, R8): the warning about a PC with little memory or few
 * processor cores, the Caps Lock hint, and the password box taking the focus back after
 * a refused sign-in. The real screens, with each panel's own `api.ts` answering from a
 * route table (`panel-harness.ts`).
 */

import type { ComponentType, ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureUi } from '../src/config.js';
import { ConfirmProvider } from '../src/ConfirmDialog.js';
import { t } from '../src/i18n.js';
import { installBrowserStubs, json, routeFetch, wait, type Call } from './panel-harness.js';

const GB = 1024 ** 3;

beforeEach(() => {
  installBrowserStubs();
  vi.stubGlobal('__APP_VERSION__', '1.4.3');
  window.localStorage.clear();
});
afterEach(cleanup);

async function load<T>(panel: 'master' | 'office', name: string): Promise<ComponentType<T>> {
  configureUi({ panel, defaultTheme: 'light', themeStorageKey: 'ob.theme' });
  const path = `../../${panel}/web/src/screens/SignInScreen.tsx`;
  const module = (await import(/* @vite-ignore */ path)) as Record<string, ComponentType<T>>;
  return module[name] as ComponentType<T>;
}

const Shell = ({ children }: { children: ReactNode }) => (
  <ConfirmProvider>{children}</ConfirmProvider>
);

const device = (totalMemoryBytes: number, cpuCount: number) => json({ totalMemoryBytes, cpuCount });

const lowMemory = (gb: string) => t('device.warning.lowMemory', { memory: gb });
const fewCores = (cores: number) => t('device.warning.fewCores', { cores });

describe('Office sign-in window', () => {
  interface Props {
    connection: Record<string, unknown>;
    onSignedIn: () => void;
    onLeft: () => void;
  }
  const connection = {
    state: 'connected',
    companyName: 'Acme',
    masterHost: '10.0.0.1',
    notRecognised: false,
  };

  async function mount(route: (call: Call) => Response | undefined) {
    const SignInScreen = await load<Props>('office', 'SignInScreen');
    const calls = routeFetch((call) => {
      if (call.url === '/api/profiles') return json([]);
      if (call.url === '/api/storage/path') return json({ dataDir: 'C:/data', freeBytes: 1e9 });
      return route(call);
    });
    render(
      <Shell>
        <SignInScreen connection={connection} onSignedIn={vi.fn()} onLeft={vi.fn()} />
      </Shell>,
    );
    return calls;
  }

  it('warns about low memory, showing how much there is', async () => {
    await mount((call) => (call.url === '/api/device' ? device(4 * GB, 8) : undefined));

    expect(await screen.findByText(lowMemory('4.0'))).toBeTruthy();
    expect(screen.queryByText(fewCores(8))).toBeNull();
  });

  it('warns about two cores, showing how many', async () => {
    await mount((call) => (call.url === '/api/device' ? device(16 * GB, 2) : undefined));

    expect(await screen.findByText(fewCores(2))).toBeTruthy();
    expect(screen.queryByTestId('device-warning')?.textContent).not.toContain('Low memory');
  });

  it('says both when both are true', async () => {
    await mount((call) => (call.url === '/api/device' ? device(6 * GB, 2) : undefined));

    expect(await screen.findByText(lowMemory('6.0'))).toBeTruthy();
    expect(screen.getByText(fewCores(2))).toBeTruthy();
  });

  it('says nothing for a PC that is fine, or when the figures cannot be read', async () => {
    const calls = await mount((call) =>
      call.url === '/api/device' ? device(16 * GB, 8) : undefined,
    );
    await waitFor(() => expect(calls.some((c) => c.url === '/api/device')).toBe(true));
    await act(async () => {
      await wait(50);
    });
    expect(screen.queryByTestId('device-warning')).toBeNull();

    cleanup();
    await mount((call) => (call.url === '/api/device' ? json({ error: 'x' }, 500) : undefined));
    await act(async () => {
      await wait(50);
    });
    expect(screen.queryByTestId('device-warning')).toBeNull();
  });

  it('shows the Caps Lock hint while it is on', async () => {
    await mount(() => undefined);
    const box = screen.getByLabelText(t('signin.password'));

    fireEvent.keyDown(box, { key: 'a', modifierCapsLock: true });
    expect(screen.getByText(t('password.capsLock'))).toBeTruthy();

    fireEvent.keyUp(box, { key: 'CapsLock', modifierCapsLock: false });
    expect(screen.queryByText(t('password.capsLock'))).toBeNull();
  });

  it('puts the cursor back in the empty password box after a refused sign-in', async () => {
    await mount((call) =>
      call.url === '/api/auth/sign-in' || call.url === '/api/sign-in'
        ? json(
            {
              error: 'unauthorized',
              message: 'no',
              messageKey: 'error.unauthorized.invalidCredentials',
            },
            401,
          )
        : undefined,
    );
    fireEvent.change(screen.getByLabelText(t('signin.username')), { target: { value: 'sam' } });
    const box = screen.getByLabelText(t('signin.password')) as HTMLInputElement;
    fireEvent.change(box, { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: t('signin.submit') }));

    await waitFor(() => expect(box.value).toBe(''));
    await waitFor(() => expect(document.activeElement).toBe(box));
  });
});

describe('Master sign-in window', () => {
  interface Props {
    onSignedIn: () => void;
    onMasterPc?: boolean;
  }

  async function mount(onMasterPc: boolean, route: (call: Call) => Response | undefined) {
    const SignInScreen = await load<Props>('master', 'SignInScreen');
    const calls = routeFetch(route);
    render(
      <Shell>
        <SignInScreen onSignedIn={vi.fn()} onMasterPc={onMasterPc} />
      </Shell>,
    );
    return calls;
  }

  it('warns on the Master PC', async () => {
    await mount(true, (call) => (call.url === '/api/device' ? device(4 * GB, 2) : undefined));

    expect(await screen.findByText(lowMemory('4.0'))).toBeTruthy();
    expect(screen.getByText(fewCores(2))).toBeTruthy();
  });

  it('does not describe the Master PC to a browser on another PC', async () => {
    const calls = await mount(false, (call) =>
      call.url === '/api/device' ? device(4 * GB, 2) : undefined,
    );
    await act(async () => {
      await wait(50);
    });

    expect(calls.some((c) => c.url === '/api/device')).toBe(false);
    expect(screen.queryByTestId('device-warning')).toBeNull();
  });
});

describe('a refused sign-in', () => {
  const refusal = () =>
    json(
      {
        error: 'unauthorized',
        message: 'Sign-in failed',
        messageKey: 'error.unauthorized.signInFailedRemaining.other',
        params: { count: 2 },
      },
      401,
    );

  async function announced(panel: 'master' | 'office', path: string) {
    configureUi({ panel, defaultTheme: 'light', themeStorageKey: 'ob.theme' });
    const { onSessionEnded } = await import('../src/sessionEnded.js');
    const apiPath = `../../${panel}/web/src/api.ts`;
    const { api } = (await import(/* @vite-ignore */ apiPath)) as {
      api: { signIn: (u: string, p: string) => Promise<unknown>; me?: () => Promise<unknown> };
    };
    routeFetch((call) => (call.url === path ? refusal() : json({}, 401)));
    const heard = vi.fn();
    const stop = onSessionEnded(heard);
    await expect(api.signIn('sam', 'wrong')).rejects.toBeTruthy();
    stop();
    return heard;
  }

  it.each([
    ['office', '/api/auth/sign-in'],
    ['master', '/api/auth/sign-in'],
  ] as const)('is not announced as an ended session on the %s panel', async (panel, path) => {
    // Nobody was signed in; the screen says why under the password box. Announcing it as
    // well put the same refusal on screen twice, the second with its {count} unfilled.
    expect((await announced(panel, path)).mock.calls).toEqual([]);
  });

  it('and neither is the Master’s boot-time check that nobody has signed in yet', async () => {
    configureUi({ panel: 'master', defaultTheme: 'light', themeStorageKey: 'ob.theme' });
    const { onSessionEnded } = await import('../src/sessionEnded.js');
    const apiPath = '../../master/web/src/api.ts';
    const { api } = (await import(/* @vite-ignore */ apiPath)) as {
      api: { me: () => Promise<unknown> };
    };
    routeFetch(() =>
      json(
        { error: 'unauthorized', message: 'Not signed in', messageKey: 'error.unauthorized' },
        401,
      ),
    );
    const heard = vi.fn();
    const stop = onSessionEnded(heard);
    await expect(api.me()).rejects.toBeTruthy();
    stop();

    expect(heard).not.toHaveBeenCalled();
  });
});
