/**
 * The card after an update (1.5): the shell's record with its times, the
 * browser's own fallback without them, the not-installed case, and once only.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureUi } from '../src/config.js';
import { t } from '../src/i18n.js';
import { UpdateFinishedCard } from '../src/UpdateRun.js';

const RECORD = {
  from: '1.4.9',
  to: '1.5.0',
  outcome: 'updated' as const,
  startedAt: '2026-10-13T10:00:00.000Z',
  finishedAt: '2026-10-13T10:01:42.000Z',
  seconds: 102,
};

function shellWith(last: unknown) {
  (window as unknown as { orderbook: unknown }).orderbook = {
    applyUpdate: vi.fn(),
    shellVersion: 'test',
    getUpdateRun: vi.fn(async () => ({ pending: null, last, installSeconds: 102 })),
  };
}

beforeEach(() => {
  configureUi({ panel: 'master', defaultTheme: 'light', themeStorageKey: 'ob.theme' });
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  delete (window as { orderbook?: unknown }).orderbook;
});

describe('the update-finished card', () => {
  it("shows the shell's record: from, to, when it started, when it was ready and how long it took", async () => {
    shellWith(RECORD);
    render(<UpdateFinishedCard running="1.5.0" />);

    expect(await screen.findByText(t('updates.finished.title'))).toBeTruthy();
    expect(
      screen.getByText(t('updates.finished.body', { from: '1.4.9', to: '1.5.0' })),
    ).toBeTruthy();
    const times = screen.getByTestId('update-finished-times').textContent ?? '';
    expect(times).toContain(t('updates.finished.took'));
    expect(times).toContain('1 min 42 s');
  });

  it('shows once: after OK the same record stays quiet', async () => {
    shellWith(RECORD);
    const first = render(<UpdateFinishedCard running="1.5.0" />);
    fireEvent.click(await screen.findByRole('button', { name: t('updates.finished.ok') }));
    expect(screen.queryByText(t('updates.finished.title'))).toBeNull();
    first.unmount();

    render(<UpdateFinishedCard running="1.5.0" />);
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText(t('updates.finished.title'))).toBeNull();
  });

  it('says plainly when the PC came back on the old version', async () => {
    shellWith({ ...RECORD, outcome: 'notInstalled', seconds: null });
    render(<UpdateFinishedCard running="1.4.9" />);

    expect(await screen.findByText(t('updates.finished.notInstalledTitle'))).toBeTruthy();
    expect(
      screen.getByText(t('updates.finished.notInstalledBody', { to: '1.5.0', running: '1.4.9' })),
    ).toBeTruthy();
  });

  it('without a shell, falls back to the version this browser last ran, with no times', async () => {
    window.localStorage.setItem('ob.updates.lastVersion', '1.4.9');
    render(<UpdateFinishedCard running="1.5.0" />);

    expect(
      await screen.findByText(t('updates.finished.body', { from: '1.4.9', to: '1.5.0' })),
    ).toBeTruthy();
    expect(screen.queryByTestId('update-finished-times')).toBeNull();
    expect(window.localStorage.getItem('ob.updates.lastVersion')).toBe('1.5.0');
  });

  it('says nothing on the first start this browser has seen', async () => {
    render(<UpdateFinishedCard running="1.5.0" />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole('status')).toBeNull();
  });
});
