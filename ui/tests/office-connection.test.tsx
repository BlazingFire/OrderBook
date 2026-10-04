/**
 * Joining a Master from the Office Panel's screens: what a person sees at each step
 * and each refusal, and that nothing can hang.
 *
 * The real screens, with the Office's own `api.ts` answering from a route table
 * (`panel-harness.ts`), so what is asserted is what a window would show.
 */

import type { ComponentType, ReactNode } from 'react';
import { ADDRESS_MESSAGE_PARAMS } from '@orderbook/shared';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureUi } from '../src/config.js';
import { ConfirmProvider } from '../src/ConfirmDialog.js';
import { t } from '../src/i18n.js';
import { installBrowserStubs, json, routeFetch, wait, type Call } from './panel-harness.js';

interface Connection {
  hasNetworkLink: boolean;
  interfaces: Array<{ name: string; address: string; broadcastAddress: string }>;
  isPaired: boolean;
  panelName: string;
  state: 'unpaired' | 'connecting' | 'connected' | 'disconnected';
  masterHost: string | null;
  masterPort: number | null;
  companyName: string | null;
  lastError: string | null;
  lastSyncedAt: string | null;
  masterVersion: string | null;
  deviceCode?: string;
  catchingUp?: boolean;
  removedByMaster?: {
    at: string;
    companyName: string | null;
    masterUniqueId: string;
    host: string;
    port: number;
  } | null;
  unsentChanges?: number;
}

const unpaired = (over: Partial<Connection> = {}): Connection => ({
  hasNetworkLink: true,
  interfaces: [{ name: 'eth0', address: '192.168.1.20', broadcastAddress: '192.168.1.255' }],
  isPaired: false,
  panelName: 'Counter 2',
  state: 'unpaired',
  masterHost: null,
  masterPort: null,
  companyName: null,
  lastError: null,
  lastSyncedAt: null,
  masterVersion: null,
  deviceCode: 'AB12',
  ...over,
});

const body = (call: Call): Record<string, unknown> => call.body as Record<string, unknown>;
const posts = (calls: Call[], path: string): Call[] =>
  calls.filter((c) => c.method === 'POST' && c.url === path);

function refusal(
  code: string,
  key: string,
  params: Record<string, unknown> = {},
  details: Record<string, unknown> = {},
  status = 400,
) {
  return json(
    { error: code, message: 'English from the server', messageKey: key, params, details },
    status,
  );
}

beforeEach(() => {
  installBrowserStubs();
  vi.stubGlobal('__APP_VERSION__', '1.4.1');
  window.localStorage.clear();
  configureUi({ panel: 'office', defaultTheme: 'light', themeStorageKey: 'ob.theme' });
});
afterEach(cleanup);

async function loadScreen<T>(file: string, name: string): Promise<ComponentType<T>> {
  const path = `../../office/web/src/${file}`;
  const module = (await import(/* @vite-ignore */ path)) as Record<string, ComponentType<T>>;
  return module[name] as ComponentType<T>;
}

const Shell = ({ children }: { children: ReactNode }) => (
  <ConfirmProvider>{children}</ConfirmProvider>
);

describe('the connection screen', () => {
  interface Props {
    connection: Connection;
    onConnected: (result?: unknown) => void;
  }

  async function mount(
    route: (call: Call) => Response | undefined,
    connection: Connection = unpaired(),
  ) {
    const ConnectionScreen = await loadScreen<Props>(
      'screens/ConnectionScreen.tsx',
      'ConnectionScreen',
    );
    const calls = routeFetch(route);
    const onConnected = vi.fn();
    render(
      <Shell>
        <ConnectionScreen connection={connection} onConnected={onConnected} />
      </Shell>,
    );
    return { calls, onConnected };
  }

  const toManual = () =>
    fireEvent.click(screen.getByRole('button', { name: t('connection.mode.manual') }));
  const address = () => screen.getByLabelText(t('connection.manual.address')) as HTMLInputElement;
  const portBox = () => screen.getByLabelText(t('connection.manual.port')) as HTMLInputElement;
  const passwordBox = () =>
    screen.getByLabelText(t('connection.manual.password')) as HTMLInputElement;
  const type = (box: HTMLInputElement, value: string) =>
    fireEvent.change(box, { target: { value } });
  const connect = () =>
    fireEvent.click(screen.getByRole('button', { name: t('connection.manual.connect') }));

  describe('auto connection', () => {
    it('says what answered and what to do, for a Master that is not accepting', async () => {
      await mount((call) =>
        call.url === '/api/connection/pair/auto'
          ? refusal(
              'not_accepting',
              'connection.error.notAccepting',
              {},
              {
                found: [
                  {
                    masterUniqueId: 'm1',
                    companyName: 'Shree Ceramics',
                    address: '192.168.1.10:4100',
                    acceptingPairing: false,
                  },
                ],
              },
            )
          : undefined,
      );

      fireEvent.click(screen.getByRole('button', { name: t('connection.auto.connect') }));

      // An alert, in the person's language, naming the Master and where it is.
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain(t('connection.error.notAccepting'));
      expect(alert.parentElement?.textContent).toContain('Shree Ceramics');
      expect(alert.parentElement?.textContent).toContain('192.168.1.10:4100');
      // Next steps beside it.
      expect(
        within(alert).getByRole('button', { name: t('connection.action.tryAgain') }),
      ).toBeTruthy();
      expect(
        within(alert).getByRole('button', { name: t('connection.action.enterManually') }),
      ).toBeTruthy();
    });

    it('"Enter the address instead" goes to manual entry, and the error does not follow it', async () => {
      await mount((call) =>
        call.url === '/api/connection/pair/auto'
          ? refusal('no_master_found', 'connection.error.noMaster')
          : undefined,
      );

      fireEvent.click(screen.getByRole('button', { name: t('connection.auto.connect') }));
      const alert = await screen.findByRole('alert');
      fireEvent.click(
        within(alert).getByRole('button', { name: t('connection.action.enterManually') }),
      );

      expect(screen.getByLabelText(t('connection.manual.address'))).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('lets the person choose when several Masters answered', async () => {
      const { calls } = await mount((call) => {
        if (call.url !== '/api/connection/pair/auto') return undefined;
        return (call.body as { masterUniqueId?: string }).masterUniqueId
          ? json({ ok: true, companyName: 'Shree Ceramics' }, 201)
          : refusal(
              'multiple_masters',
              'connection.error.multipleMasters',
              {},
              {
                found: [
                  {
                    masterUniqueId: 'm1',
                    companyName: 'Shree Ceramics',
                    address: '192.168.1.10:4100',
                    acceptingPairing: true,
                  },
                  {
                    masterUniqueId: 'm2',
                    companyName: 'Test Company',
                    address: '192.168.1.30:4100',
                    acceptingPairing: true,
                  },
                ],
              },
            );
      });

      fireEvent.click(screen.getByRole('button', { name: t('connection.auto.connect') }));
      const alert = await screen.findByRole('alert');
      const rows = alert.parentElement!.querySelectorAll('li');
      expect(rows).toHaveLength(2);

      fireEvent.click(
        within(rows[1] as HTMLElement).getByRole('button', { name: t('connection.pick.connect') }),
      );

      await waitFor(() => expect(posts(calls, '/api/connection/pair/auto')).toHaveLength(2));
      expect(body(posts(calls, '/api/connection/pair/auto')[1]!).masterUniqueId).toBe('m2');
    });

    it('shows the search going and stops it on Stop, with no error afterwards', async () => {
      let signal: AbortSignal | null = null;
      const real = globalThis.fetch;
      const { calls } = await mount(() => undefined);
      // routeFetch answers a call that settles never; capture the signal it was given.
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          if (String(input) === '/api/connection/pair/auto') {
            signal = init?.signal ?? null;
            return new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener(
                'abort',
                () => reject(new DOMException('aborted', 'AbortError')),
                { once: true },
              );
            });
          }
          return real(input, init);
        }),
      );

      fireEvent.click(screen.getByRole('button', { name: t('connection.auto.connect') }));

      expect(await screen.findByRole('status')).toBeTruthy();
      expect(screen.getByText(t('connection.search.progress', { seconds: 0 }))).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: t('connection.action.stop') }));

      await waitFor(() => expect(signal?.aborted).toBe(true));
      await waitFor(() =>
        expect(screen.getByRole('button', { name: t('connection.auto.connect') })).toHaveProperty(
          'disabled',
          false,
        ),
      );
      expect(screen.queryByRole('alert')).toBeNull();
      void calls;
    });

    it('a search shows the Masters it found, each with a Connect for the ones accepting', async () => {
      const { calls } = await mount((call) => {
        if (call.url === '/api/connection/scan') {
          return json({
            masters: [
              {
                masterUniqueId: 'm1',
                companyName: 'Shree Ceramics',
                lanIp: '10.9.9.9',
                addresses: ['192.168.1.10', '10.9.9.9'],
                httpPort: 4100,
                acceptingPairing: true,
              },
              {
                masterUniqueId: 'm2',
                companyName: 'Other',
                lanIp: '192.168.1.30',
                addresses: ['192.168.1.30'],
                httpPort: 4100,
                acceptingPairing: false,
              },
            ],
          });
        }
        if (call.url === '/api/connection/pair/auto')
          return json({ ok: true, companyName: 'Shree Ceramics' }, 201);
        return undefined;
      });

      fireEvent.click(screen.getByRole('button', { name: t('connection.auto.scanOnly') }));
      await screen.findByText('Shree Ceramics');

      // The address shown is the one it answered from, not the one it claims.
      expect(screen.getByText('192.168.1.10:4100')).toBeTruthy();
      const buttons = screen.getAllByRole('button', { name: t('connection.pick.connect') });
      expect((buttons[0] as HTMLButtonElement).disabled).toBe(false);
      expect((buttons[1] as HTMLButtonElement).disabled).toBe(true);

      fireEvent.click(buttons[0]!);
      await waitFor(() => expect(posts(calls, '/api/connection/pair/auto')).toHaveLength(1));
      expect(body(posts(calls, '/api/connection/pair/auto')[0]!).masterUniqueId).toBe('m1');
    });
  });

  describe('manual connection', () => {
    it('checks the address and port as typed, and sends nothing while they are wrong', async () => {
      const { calls } = await mount(() => json({ ok: true, companyName: 'X' }, 201));
      toManual();

      type(address(), 'not an address');
      type(passwordBox(), 'pw');
      connect();
      expect(
        await screen.findByText(t('connection.error.invalidAddress', ADDRESS_MESSAGE_PARAMS)),
      ).toBeTruthy();

      type(address(), '192.168.1.10');
      type(portBox(), '70000');
      connect();
      expect(
        await screen.findByText(t('connection.error.invalidPort', ADDRESS_MESSAGE_PARAMS)),
      ).toBeTruthy();

      type(portBox(), '');
      type(address(), '');
      connect();
      expect(await screen.findByText(t('connection.error.emptyAddress'))).toBeTruthy();

      expect(posts(calls, '/api/connection/pair/manual')).toEqual([]);
    });

    it('wants a password, and says so', async () => {
      const { calls } = await mount(() => undefined);
      toManual();
      type(address(), '192.168.1.10');
      connect();

      expect(await screen.findByText(t('connection.error.passwordMissing'))).toBeTruthy();
      expect(posts(calls, '/api/connection/pair/manual')).toEqual([]);
    });

    it('reads "host:port" and sends the address cleanly', async () => {
      const { calls, onConnected } = await mount(() =>
        json({ ok: true, companyName: 'Shree Ceramics', newMaster: false, parkedChanges: 0 }, 201),
      );
      toManual();
      type(address(), ' http://192.168.1.10:4200/ ');
      type(passwordBox(), 'secret');
      connect();

      await waitFor(() => expect(onConnected).toHaveBeenCalled());
      expect(body(posts(calls, '/api/connection/pair/manual')[0]!)).toMatchObject({
        host: '192.168.1.10',
        port: '4200',
        pairingPassword: 'secret',
        panelName: 'Counter 2',
      });
    });

    it('a wrong password is said in words, the box is emptied and the cursor goes back to it', async () => {
      await mount(() => refusal('wrong_password', 'connection.error.wrongPassword', {}, {}, 400));
      toManual();
      type(address(), '192.168.1.10');
      type(passwordBox(), 'nope');
      connect();

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain(t('connection.error.wrongPassword'));
      await waitFor(() => expect(passwordBox().value).toBe(''));
      expect(document.activeElement).toBe(passwordBox());
    });

    it('the rate limit says how many seconds, and Connect waits them out', async () => {
      await mount(() =>
        refusal(
          'rate_limited',
          'connection.error.rateLimited',
          { seconds: 30 },
          { seconds: 30 },
          429,
        ),
      );
      toManual();
      type(address(), '192.168.1.10');
      type(passwordBox(), 'nope');
      connect();

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain(t('connection.error.rateLimited', { seconds: 30 }));
      const button = screen.getByRole('button', {
        name: t('connection.manual.connect'),
      }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      // Said once, not twice (the banner is the only place), and it counts down.
      expect(screen.getAllByText(t('connection.error.rateLimited', { seconds: 30 }))).toHaveLength(
        1,
      );
      expect(
        await screen.findByText(
          t('connection.error.rateLimited', { seconds: 29 }),
          {},
          { timeout: 3000 },
        ),
      ).toBeTruthy();
      expect(screen.getByRole('alert').textContent).toContain(
        t('connection.error.rateLimited', { seconds: 29 }),
      );
    });

    it('a later mistake in the address replaces the old wrong-password banner', async () => {
      await mount(() => refusal('wrong_password', 'connection.error.wrongPassword', {}, {}, 400));
      toManual();
      type(address(), '192.168.1.10');
      type(passwordBox(), 'nope');
      connect();
      await screen.findByText(t('connection.error.wrongPassword'));

      type(address(), 'not an address');
      type(passwordBox(), 'pw');
      connect();

      expect(
        await screen.findByText(t('connection.error.invalidAddress', ADDRESS_MESSAGE_PARAMS)),
      ).toBeTruthy();
      expect(screen.queryByText(t('connection.error.wrongPassword'))).toBeNull();
    });

    it('shows progress while connecting and can be cancelled', async () => {
      const { calls } = await mount(() => undefined);
      let signal: AbortSignal | null = null;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          if (String(input) === '/api/connection/pair/manual') {
            signal = init?.signal ?? null;
            return new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener(
                'abort',
                () => reject(new DOMException('aborted', 'AbortError')),
                { once: true },
              );
            });
          }
          return new Promise<Response>(() => undefined);
        }),
      );
      toManual();
      type(address(), '192.168.1.10');
      type(passwordBox(), 'pw');
      connect();

      expect(
        await screen.findByRole('button', { name: t('connection.manual.connecting') }),
      ).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: t('action.cancel') }));

      await waitFor(() => expect(signal?.aborted).toBe(true));
      await waitFor(() =>
        expect(screen.getByRole('button', { name: t('connection.manual.connect') })).toBeTruthy(),
      );
      expect(screen.queryByRole('alert')).toBeNull();
      void calls;
    });

    it('Test connection reports the Master and its version before anything is paired', async () => {
      const { calls } = await mount((call) =>
        call.url === '/api/connection/test'
          ? json({
              host: '192.168.1.10',
              port: 4100,
              version: '1.4.1',
              status: 'ok',
              mine: '1.4.1',
              standing: 'same',
            })
          : undefined,
      );
      toManual();
      type(address(), '192.168.1.10');
      fireEvent.click(screen.getByRole('button', { name: t('connection.manual.test') }));

      expect(
        await screen.findByText(
          t('connection.test.ok', { address: '192.168.1.10:4100', version: '1.4.1' }),
        ),
      ).toBeTruthy();
      expect(screen.getByText(t('connection.test.same'))).toBeTruthy();
      expect(body(posts(calls, '/api/connection/test')[0]!)).toMatchObject({
        host: '192.168.1.10',
        port: '4100',
      });
      expect(posts(calls, '/api/connection/pair/manual')).toEqual([]);
    });

    it('Test connection warns when the versions differ, in either direction, and when it is still starting', async () => {
      let answer: Record<string, unknown> = {};
      await mount((call) => (call.url === '/api/connection/test' ? json(answer) : undefined));
      toManual();
      type(address(), '192.168.1.10');
      const test = () =>
        fireEvent.click(screen.getByRole('button', { name: t('connection.manual.test') }));

      answer = {
        host: '192.168.1.10',
        port: 4100,
        version: '1.5.0',
        status: 'ok',
        mine: '1.4.1',
        standing: 'behind',
      };
      test();
      expect(
        await screen.findByText(
          t('connection.test.masterNewer', { master: '1.5.0', mine: '1.4.1' }),
        ),
      ).toBeTruthy();

      answer = {
        host: '192.168.1.10',
        port: 4100,
        version: '1.3.0',
        status: 'starting',
        mine: '1.4.1',
        standing: 'ahead',
      };
      test();
      expect(
        await screen.findByText(
          t('connection.test.masterOlder', { master: '1.3.0', mine: '1.4.1' }),
        ),
      ).toBeTruthy();
      expect(screen.getByText(t('connection.test.starting'))).toBeTruthy();
    });

    it('Test connection failing is an alert with the reason', async () => {
      await mount(() =>
        refusal('connection_refused', 'connection.error.connectionRefused', {
          address: '192.168.1.10:4100',
          port: 4100,
        }),
      );
      toManual();
      type(address(), '192.168.1.10');
      fireEvent.click(screen.getByRole('button', { name: t('connection.manual.test') }));

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain(
        t('connection.error.connectionRefused', { address: '192.168.1.10:4100', port: 4100 }),
      );
    });

    it('remembers the last address that worked and offers it next time', async () => {
      const first = await mount(() => json({ ok: true, companyName: 'Shree Ceramics' }, 201));
      toManual();
      type(address(), '192.168.1.10');
      type(portBox(), '4200');
      type(passwordBox(), 'secret');
      connect();
      await waitFor(() => expect(first.onConnected).toHaveBeenCalled());
      cleanup();

      await mount(() => undefined);
      toManual();
      expect(address().value).toBe('192.168.1.10');
      expect(portBox().value).toBe('4200');
      // The password is never kept.
      expect(passwordBox().value).toBe('');
      expect(window.localStorage.getItem('ob.office.lastMaster')).not.toContain('secret');
    });

    it('does not remember an address that failed', async () => {
      await mount(() => refusal('wrong_password', 'connection.error.wrongPassword'));
      toManual();
      type(address(), '192.168.1.10');
      type(passwordBox(), 'nope');
      connect();
      await screen.findByRole('alert');

      expect(window.localStorage.getItem('ob.office.lastMaster')).toBeNull();
    });
  });

  describe('after the Master removed this PC', () => {
    it('says so, with the company and when, and what happens to work not yet sent', async () => {
      await mount(
        () => undefined,
        unpaired({
          removedByMaster: {
            at: '2026-10-04T09:30:00.000Z',
            companyName: 'Shree Ceramics',
            masterUniqueId: 'm1',
            host: '192.168.1.10',
            port: 4100,
          },
          unsentChanges: 3,
        }),
      );

      const alert = screen.getByRole('alert');
      expect(alert.textContent).toContain(t('connection.removed.title'));
      expect(alert.textContent).toContain('Shree Ceramics');
      expect(alert.textContent).toContain('3');
      // And the address it had is already in the manual form.
      toManual();
      expect(address().value).toBe('192.168.1.10');
    });

    it('shows nothing of the kind on a PC that was never paired', async () => {
      await mount(() => undefined);
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });
});

describe('the first sync after pairing', () => {
  interface Props {
    connection: Connection;
    result: {
      ok: true;
      companyName: string | null;
      newMaster?: boolean;
      parkedChanges?: number;
    } | null;
    onContinue: () => void;
    onLeft: () => void;
  }

  async function mount(
    connection: Connection,
    result: Props['result'] = { ok: true, companyName: 'Shree Ceramics' },
  ) {
    const SetupScreen = await loadScreen<Props>('screens/SetupScreen.tsx', 'SetupScreen');
    routeFetch(() => undefined);
    const onContinue = vi.fn();
    const onLeft = vi.fn();
    const view = render(
      <Shell>
        <SetupScreen
          connection={connection}
          result={result}
          onContinue={onContinue}
          onLeft={onLeft}
        />
      </Shell>,
    );
    const rerender = async (next: Connection) => {
      view.rerender(
        <Shell>
          <SetupScreen connection={next} result={result} onContinue={onContinue} onLeft={onLeft} />
        </Shell>,
      );
    };
    return { onContinue, onLeft, rerender };
  }

  const paired = (over: Partial<Connection>): Connection =>
    unpaired({
      isPaired: true,
      companyName: 'Shree Ceramics',
      masterHost: '192.168.1.10',
      masterPort: 4100,
      ...over,
    });

  it('goes from connecting to receiving the data to ready, and carries on by itself when there is nothing to read', async () => {
    const { onContinue, rerender } = await mount(paired({ state: 'connecting' }));
    expect(screen.getByRole('status').textContent).toBe(
      t('connection.setup.connecting', { company: 'Shree Ceramics' }),
    );

    await rerender(paired({ state: 'connected', catchingUp: true }));
    expect(screen.getByRole('status').textContent).toBe(
      t('connection.setup.receiving', { company: 'Shree Ceramics' }),
    );
    expect(onContinue).not.toHaveBeenCalled();

    await rerender(
      paired({
        state: 'connected',
        catchingUp: false,
        lastSyncedAt: '2026-10-04T10:00:00.000Z',
        masterVersion: '1.4.1',
      }),
    );
    expect(screen.getByRole('status').textContent).toBe(
      t('connection.setup.ready', { company: 'Shree Ceramics' }),
    );
    await waitFor(() => expect(onContinue).toHaveBeenCalledTimes(1), { timeout: 3000 });
  });

  it('does not move on by itself when there is something to read: a different Master, set-aside work, a version difference', async () => {
    const { onContinue } = await mount(
      paired({
        state: 'connected',
        catchingUp: false,
        lastSyncedAt: '2026-10-04T10:00:00.000Z',
        masterVersion: '1.5.0',
      }),
      { ok: true, companyName: 'Shree Ceramics', newMaster: true, parkedChanges: 4 },
    );

    expect(screen.getByText(t('connection.setup.newMaster'))).toBeTruthy();
    expect(screen.getByText(t('connection.setup.parked', { count: 4 }))).toBeTruthy();
    expect(
      screen.getByText(t('connection.test.masterNewer', { master: '1.5.0', mine: '1.4.1' })),
    ).toBeTruthy();

    await wait(1800);
    expect(onContinue).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: t('connection.setup.continue') }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('says why when the Master cannot be reached, and still lets the person carry on', async () => {
    const { onContinue } = await mount(
      paired({ state: 'disconnected', lastError: 'websocket error' }),
    );

    expect(screen.getByRole('alert').textContent).toContain(
      t('connection.setup.failed', { reason: 'websocket error' }),
    );
    fireEvent.click(screen.getByRole('button', { name: t('connection.setup.continue') }));
    expect(onContinue).toHaveBeenCalled();
  });
});

describe('leaving a Master from the screen', () => {
  interface Props {
    company: string | null;
    onDone: () => void;
    canDiscard?: boolean;
  }

  async function mount(
    route: (call: Call) => Response | undefined,
    props: { canDiscard?: boolean } = {},
  ) {
    const ConnectionUnpair = await loadScreen<Props>(
      'components/ConnectionUnpair.tsx',
      'ConnectionUnpair',
    );
    const calls = routeFetch(route);
    const onDone = vi.fn();
    render(
      <Shell>
        <ConnectionUnpair company="Shree Ceramics" onDone={onDone} {...props} />
      </Shell>,
    );
    return { calls, onDone };
  }

  const start = () =>
    fireEvent.click(screen.getByRole('button', { name: t('connection.unpair.action') }));

  it('asks first, saying what will happen, and does nothing if the answer is no', async () => {
    const { calls, onDone } = await mount(() =>
      json({ ok: true, keptChanges: 0, discardedChanges: 0 }),
    );

    start();
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain(
      t('connection.unpair.body', { company: 'Shree Ceramics' }),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: t('common.cancel') }));

    await act(async () => {
      await wait(50);
    });
    expect(posts(calls, '/api/connection/unpair')).toEqual([]);
    expect(onDone).not.toHaveBeenCalled();
  });

  it('leaves once confirmed, when nothing is waiting to be sent', async () => {
    const { calls, onDone } = await mount(() =>
      json({ ok: true, keptChanges: 0, discardedChanges: 0 }),
    );

    start();
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: t('connection.unpair.confirm'),
      }),
    );

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(body(posts(calls, '/api/connection/unpair')[0]!).pending).toBeUndefined();
  });

  it('asks a second time, with the count, when work was never sent, and does not leave until told how', async () => {
    const { calls, onDone } = await mount((call) =>
      (call.body as { pending?: string }).pending
        ? json({ ok: true, keptChanges: 2, discardedChanges: 0 })
        : refusal(
            'pending_changes',
            'connection.unpair.pendingBlocked',
            { count: 2 },
            { count: 2 },
            409,
          ),
    );

    start();
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: t('connection.unpair.confirm'),
      }),
    );

    const second = await screen.findByText(t('connection.unpair.pendingBody', { count: 2 }));
    expect(second).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: t('connection.unpair.keep') }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(body(posts(calls, '/api/connection/unpair').at(-1)!).pending).toBe('keep');
  });

  it('can discard the work instead, which is a separate, explicit button', async () => {
    const { calls, onDone } = await mount((call) =>
      (call.body as { pending?: string }).pending
        ? json({ ok: true, keptChanges: 0, discardedChanges: 2 })
        : refusal(
            'pending_changes',
            'connection.unpair.pendingBlocked',
            { count: 2 },
            { count: 2 },
            409,
          ),
    );

    start();
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: t('connection.unpair.confirm'),
      }),
    );
    await screen.findByText(t('connection.unpair.pendingBody', { count: 2 }));
    fireEvent.click(screen.getByRole('button', { name: t('connection.unpair.discard') }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(body(posts(calls, '/api/connection/unpair').at(-1)!).pending).toBe('discard');
  });

  it('offers no discard where nobody is signed in', async () => {
    await mount(
      () =>
        refusal(
          'pending_changes',
          'connection.unpair.pendingBlocked',
          { count: 2 },
          { count: 2 },
          409,
        ),
      { canDiscard: false },
    );

    start();
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: t('connection.unpair.confirm'),
      }),
    );
    await screen.findByText(t('connection.unpair.pendingBody', { count: 2 }));
    expect(screen.getByRole('button', { name: t('connection.unpair.keep') })).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('connection.unpair.discard') })).toBeNull();
  });

  it('cancelling the second question leaves nothing changed', async () => {
    const { onDone } = await mount(() =>
      refusal(
        'pending_changes',
        'connection.unpair.pendingBlocked',
        { count: 2 },
        { count: 2 },
        409,
      ),
    );

    start();
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: t('connection.unpair.confirm'),
      }),
    );
    await screen.findByText(t('connection.unpair.pendingBody', { count: 2 }));
    fireEvent.click(screen.getByRole('button', { name: t('action.cancel') }));

    await waitFor(() =>
      expect(screen.queryByText(t('connection.unpair.pendingBody', { count: 2 }))).toBeNull(),
    );
    expect(onDone).not.toHaveBeenCalled();
  });
});
