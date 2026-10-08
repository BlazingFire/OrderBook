/**
 * The Master's Panels screen and its Add Office Panel card (Connection audit M2, M3, M14,
 * B4, B6): a countdown while the window is open and an expiry once it is not, the setting
 * that makes joining need the password, the addresses to type by hand, the automatic search
 * not running, "Reissue secret" only for a connected panel, and removed rows out of the way.
 *
 * Imported through a variable path for the reason `panel-harness.ts` gives.
 */

import type { ComponentType } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OfficePanelWithPresence, PairingWindowState } from '@orderbook/shared';

import { configureUi } from '../src/config.js';
import { t } from '../src/i18n.js';
import { installBrowserStubs, json, routeFetch, type Call } from './panel-harness.js';

interface Props {
  panels: OfficePanelWithPresence[];
  onRefresh: () => void;
  onOpenSettings?: () => void;
}

async function loadScreen(): Promise<ComponentType<Props>> {
  configureUi({ panel: 'master', defaultTheme: 'light', themeStorageKey: 'ob.theme' });
  const path = '../../master/web/src/screens/PanelsScreen.tsx';
  return ((await import(/* @vite-ignore */ path)) as { PanelsScreen: ComponentType<Props> }).PanelsScreen;
}

function panel(id: string, name: string, over: Partial<OfficePanelWithPresence> = {}): OfficePanelWithPresence {
  return {
    id,
    name,
    deviceCode: `DC-${id}`,
    status: 'active',
    lanIp: '192.168.1.20',
    pairedAt: '2026-10-01T10:00:00.000Z',
    lastSeenAt: '2026-10-04T10:00:00.000Z',
    isConnected: false,
    runtime: null,
    ...over,
  } as unknown as OfficePanelWithPresence;
}

function state(over: Partial<PairingWindowState> = {}): PairingWindowState {
  return {
    open: false,
    closesAt: null,
    autoPairingEnabled: true,
    accepting: false,
    port: 4100,
    addresses: [{ name: 'Ethernet', address: '192.168.1.10' }],
    discovery: { listening: true, port: 45789, reason: null },
    officeSetups: [],
    ...over,
  };
}

beforeEach(() => {
  installBrowserStubs();
});
afterEach(cleanup);

async function mount(
  panels: OfficePanelWithPresence[],
  windowState: PairingWindowState,
  openState: Partial<PairingWindowState> = {},
  extra: (call: Call) => Response | undefined = () => undefined,
): Promise<Call[]> {
  let opened = false;
  const calls = routeFetch((call) => {
    const custom = extra(call);
    if (custom) return custom;
    // Once opened, the Master keeps saying so until the test says otherwise (the screen re-reads it as the list changes).
    if (call.method === 'GET' && call.url === '/api/panels/pairing-window') {
      return json(opened ? { ...windowState, open: true, accepting: windowState.autoPairingEnabled, ...openState } : windowState);
    }
    if (call.method === 'POST' && call.url === '/api/panels/pairing-window/open') {
      opened = true;
      return json({ ...windowState, open: true, accepting: windowState.autoPairingEnabled, ...openState });
    }
    if (call.method === 'POST' && call.url === '/api/panels/pairing-window/close') return new Response(null, { status: 204 });
    return undefined;
  });
  const Screen = await loadScreen();
  render(<Screen panels={panels} onRefresh={() => undefined} />);
  return calls;
}

const openWindow = () => fireEvent.click(screen.getByRole('button', { name: t('panels.add.action') }));

describe('the Add Office Panel card', () => {
  it('shows the addresses to type by hand, with the port, before anything is opened', async () => {
    await mount([], state({ addresses: [{ name: 'Ethernet', address: '192.168.1.10' }, { name: 'Wi-Fi', address: '10.0.0.4' }] }));
    expect(await screen.findByText(t('panels.add.manualTitle'))).toBeTruthy();
    expect(screen.getByText(/192\.168\.1\.10:4100/)).toBeTruthy();
    expect(screen.getByText(/10\.0\.0\.4:4100/)).toBeTruthy();
    expect(screen.getByText(t('panels.add.manualBody'))).toBeTruthy();
  });

  it('counts down while the window is open', async () => {
    await mount([], state(), { closesAt: Date.now() + 90_000 });
    await screen.findByText(t('panels.add.manualTitle'));
    openWindow();
    expect(await screen.findByText(t('panels.add.waitingTitle'))).toBeTruthy();
    expect(screen.getByText(/1:(2\d|30)/)).toBeTruthy();
  });

  it('says so when the window runs out, instead of waiting for ever, and the button opens it again', async () => {
    const calls = await mount([], state(), { closesAt: Date.now() + 1200 });
    await screen.findByText(t('panels.add.manualTitle'));
    openWindow();
    await screen.findByText(t('panels.add.waitingTitle'));

    expect(await screen.findByText(t('panels.add.expiredTitle'), {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.queryByText(t('panels.add.waitingTitle'))).toBeNull();
    expect(screen.getByRole('button', { name: t('panels.add.action') })).toBeTruthy();
    expect(calls.filter((call) => call.url.endsWith('/pairing-window/open'))).toHaveLength(1);
  });

  it('says joining needs the password when the setting is off, instead of waiting for a panel that cannot come', async () => {
    await mount([], state({ autoPairingEnabled: false }), { closesAt: Date.now() + 60_000 });
    await screen.findByText(t('panels.add.manualTitle'));
    openWindow();
    expect(await screen.findByText(t('panels.add.autoOffTitle'))).toBeTruthy();
    expect(screen.queryByText(t('panels.add.waitingTitle'))).toBeNull();
  });

  it('says automatic joining is off before anything is pressed, with a link to the setting', async () => {
    let opened = 0;
    const Screen = await loadScreen();
    routeFetch((call) =>
      call.method === 'GET' && call.url === '/api/panels/pairing-window' ? json(state({ autoPairingEnabled: false })) : undefined,
    );
    render(<Screen panels={[]} onRefresh={() => undefined} onOpenSettings={() => void (opened += 1)} />);

    expect(await screen.findByText(new RegExp(t('panels.add.autoOffNotice')))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('panels.add.autoOffLink') }));
    expect(opened).toBe(1);
    // The line under the heading must not tell somebody to start automatic connection in the same breath.
    expect(screen.queryByText(t('panels.add.description'))).toBeNull();
    expect(screen.getByText(t('panels.add.descriptionAutoOff'))).toBeTruthy();
  });

  it('shows no such notice while joining is on, and no link for somebody who cannot open Settings', async () => {
    await mount([], state());
    await screen.findByText(t('panels.add.manualTitle'));
    expect(screen.queryByText(new RegExp(t('panels.add.autoOffNotice')))).toBeNull();
    expect(screen.getByText(t('panels.add.description'))).toBeTruthy();
    cleanup();

    await mount([], state({ autoPairingEnabled: false }));
    expect(await screen.findByText(new RegExp(t('panels.add.autoOffNotice')))).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('panels.add.autoOffLink') })).toBeNull();
  });

  it('says the automatic search is not running, with the reason', async () => {
    await mount([], state({ discovery: { listening: false, port: 45789, reason: 'bind EADDRINUSE 0.0.0.0:45789' } }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('EADDRINUSE');
    expect(alert.textContent).toContain(t('panels.add.discoveryDown', { reason: 'bind EADDRINUSE 0.0.0.0:45789' }));
  });

  it('offers the Office setup this Master carries, to save and at an address a new PC can open', async () => {
    const officeSetups = [
      { platform: 'win32', version: '1.4.7', file: 'OrderBook-Office-1.4.7-Setup.exe', sizeBytes: 85_451_175 },
      { platform: 'win7', version: '1.4.7', file: 'OrderBook-Office-Win7-1.4.7-Setup.exe', sizeBytes: 140_181_230 },
    ] satisfies PairingWindowState['officeSetups'];
    await mount([], state({ officeSetups }));

    expect(await screen.findByText(t('panels.add.officeSetupTitle'))).toBeTruthy();
    // A download link, not a request the screen makes: the shell's Save As dialog picks the USB drive.
    const save = screen.getByRole('link', { name: t('panels.add.officeSetupSave') });
    expect(save.getAttribute('href')).toBe('/api/updates/office/setup');
    expect(save.hasAttribute('download')).toBe(true);
    const win7 = screen.getByRole('link', { name: t('panels.add.officeSetupSaveWin7') });
    expect(win7.getAttribute('href')).toBe('/api/updates/office/setup?platform=win7');
    expect(screen.getByText(/OrderBook-Office-1\.4\.7-Setup\.exe, 81\.5 MB/)).toBeTruthy();

    // What to type on the new PC, from this Master's own address and port.
    const text = document.body.textContent ?? '';
    expect(text).toContain('http://192.168.1.10:4100/api/updates/office/setup');
    expect(text).toContain('http://192.168.1.10:4100/api/updates/office/setup?platform=win7');
  });

  it('offers no Office setup when this Master carries none', async () => {
    await mount([], state());
    await screen.findByText(t('panels.add.manualTitle'));
    expect(screen.queryByText(t('panels.add.officeSetupTitle'))).toBeNull();
    expect(screen.queryByRole('link', { name: t('panels.add.officeSetupSave') })).toBeNull();
  });
});

describe('the wait ends when the Master says the window closed', () => {
  it('returns to the Add button when a PC is given its old row back (the count does not grow)', async () => {
    let open = true;
    const calls = routeFetch((call) => {
      if (call.method === 'GET' && call.url === '/api/panels/pairing-window') return json(state({ open, closesAt: open ? Date.now() + 240_000 : null, accepting: open }));
      if (call.method === 'POST' && call.url === '/api/panels/pairing-window/open') return json(state({ open: true, closesAt: Date.now() + 240_000, accepting: true }));
      if (call.method === 'POST' && call.url === '/api/panels/pairing-window/close') return new Response(null, { status: 204 });
      return undefined;
    });
    const Screen = await loadScreen();
    const removed = panel('a', 'Reception', { status: 'revoked' });
    const view = render(<Screen panels={[removed]} onRefresh={() => undefined} />);
    await screen.findByText(t('panels.add.manualTitle'));
    openWindow();
    expect(await screen.findByText(t('panels.add.waitingTitle'))).toBeTruthy();

    // The Master gives the removed row back and closes the window: one row before, one after.
    open = false;
    view.rerender(<Screen panels={[panel('a', 'Reception', { isConnected: true })]} onRefresh={() => undefined} />);

    await waitFor(() => expect(screen.queryByText(t('panels.add.waitingTitle'))).toBeNull());
    expect(screen.getByRole('button', { name: t('panels.add.action') })).toBeTruthy();
    expect(calls.filter((call) => call.url === '/api/panels/pairing-window').length).toBeGreaterThan(1);
  });
});

describe('the list', () => {
  it('says there are no active panels, not that there never were any, when every panel was removed', async () => {
    await mount([panel('b', 'Old counter', { status: 'revoked' })], state());
    expect(await screen.findByText(t('panels.empty.noActive'))).toBeTruthy();
    expect(screen.queryByText(t('panels.empty.title'))).toBeNull();
    expect(screen.getByRole('button', { name: t('panels.list.showRemoved', { count: 1 }) })).toBeTruthy();
    cleanup();

    await mount([], state());
    expect(await screen.findByText(t('panels.empty.title'))).toBeTruthy();
  });

  it('keeps removed panels out of the list until asked, and says how many there are', async () => {
    await mount([panel('a', 'Reception'), panel('b', 'Old counter', { status: 'revoked' })], state());
    expect(await screen.findByText('Reception')).toBeTruthy();
    expect(screen.queryByText('Old counter')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: t('panels.list.showRemoved', { count: 1 }) }));
    expect(screen.getByText('Old counter')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('panels.list.hideRemoved') }));
    expect(screen.queryByText('Old counter')).toBeNull();
  });

  it('offers Reissue secret for a connected panel, behind a confirmation that says what it does, and not for an offline one', async () => {
    const calls = await mount([panel('a', 'Reception', { isConnected: true }), panel('b', 'Counter')], state(), {}, (call) =>
      call.method === 'POST' && call.url === '/api/panels/a/rotate-secret'
        ? json({ panelId: 'a', panelSecret: 'x', delivered: true, rotatedAt: '2026-10-04T10:00:00.000Z' })
        : undefined,
    );
    fireEvent.click((await screen.findAllByRole('button', { name: t('panels.action.open') }))[0]!);
    fireEvent.click(await screen.findByRole('button', { name: t('panels.rotate.action') }));
    expect(screen.getByText(t('panels.rotate.body'))).toBeTruthy();
    expect(calls.some((call) => call.url.endsWith('/rotate-secret'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: t('panels.rotate.confirm') }));
    await waitFor(() => expect(calls.some((call) => call.url === '/api/panels/a/rotate-secret')).toBe(true));
    // Nothing of the new secret is shown or kept: it travels to the panel over its own connection.
    expect(document.body.textContent).not.toContain('"x"');
  });

  it('does not offer it for a panel that is not connected', async () => {
    await mount([panel('b', 'Counter')], state());
    fireEvent.click((await screen.findAllByRole('button', { name: t('panels.action.open') }))[0]!);
    await screen.findByText(t('panels.action.rename'));
    expect(screen.queryByRole('button', { name: t('panels.rotate.action') })).toBeNull();
  });
});
