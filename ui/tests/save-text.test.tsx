/**
 * "Save to .txt" (1.4.3 R4): what the file says, that the button writes it and sends nothing anywhere,
 * and that every screen that shows a value once offers it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ComponentType } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureUi } from '../src/config.js';
import { t } from '../src/i18n.js';
import { buildSavedText, savedFileName, SaveTextButton } from '../src/SaveTextButton.js';
import { installBrowserStubs, routeFetch } from './panel-harness.js';

beforeEach(() => {
  installBrowserStubs();
  configureUi({ panel: 'master', defaultTheme: 'light', themeStorageKey: 'ob.theme' });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const NOW = new Date(2026, 9, 5, 14, 32);

/** jsdom's Blob has no `text()`. */
function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

describe('buildSavedText', () => {
  const text = buildSavedText({
    title: 'First-run details',
    now: NOW,
    device: 'localhost:4100 · Win32',
    sections: [
      { heading: 'Sign-in accounts', values: [{ label: 'Username', value: 'admin' }, { label: 'Display name', value: 'Owner' }] },
      { heading: 'Empty', values: [] },
      { values: [{ label: 'Pairing password', value: 'abcd-efgh-1234' }] },
    ],
  });

  it('says what it is, when it was saved, which application and device', () => {
    const lines = text.split('\r\n');
    expect(lines[0]).toBe('OrderBook — First-run details');
    expect(text).toContain('Saved: 2026-10-05 14:32');
    expect(text).toContain('Application: Master Panel');
    expect(text).toContain('Device: localhost:4100 · Win32');
  });

  it('lists every value under its heading, skips an empty section, and uses Windows line ends', () => {
    expect(text).toContain('Sign-in accounts\r\n----------------\r\nUsername: admin\r\nDisplay name: Owner');
    expect(text).not.toContain('Empty');
    expect(text).toContain('Pairing password: abcd-efgh-1234');
    expect(text.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('ends by telling the reader to keep the file private', () => {
    expect(text.trimEnd().endsWith(t('saveText.file.keepPrivate'))).toBe(true);
  });

  it('names the Office Panel when it runs there', () => {
    configureUi({ panel: 'office', defaultTheme: 'light', themeStorageKey: 'ob.theme' });
    expect(buildSavedText({ title: 'x', sections: [], now: NOW, device: 'd' })).toContain('Application: Office Panel');
  });
});

describe('savedFileName', () => {
  it('is safe on every file system and carries the date', () => {
    expect(savedFileName('First run!', NOW)).toBe('orderbook-first-run-2026-10-05.txt');
    expect(savedFileName('', NOW)).toBe('orderbook-setup-2026-10-05.txt');
  });
});

describe('SaveTextButton', () => {
  it('downloads the text as a .txt on this PC and sends nothing', async () => {
    const calls = routeFetch(() => undefined);
    let blob: Blob | null = null;
    URL.createObjectURL = vi.fn((made: Blob | MediaSource) => {
      blob = made as Blob;
      return 'blob:x';
    });
    URL.revokeObjectURL = vi.fn();
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this.download);
    });

    render(
      <SaveTextButton
        title="Password for kiran"
        slug="password"
        sections={[{ values: [{ label: 'Username', value: 'kiran' }, { label: 'Password', value: 'S3cret-pass' }] }]}
      />,
    );
    expect(screen.queryByText(t('saveText.done'))).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t('saveText.button') }));

    expect(clicked).toHaveLength(1);
    expect(clicked[0]).toMatch(/^orderbook-password-\d{4}-\d{2}-\d{2}\.txt$/);
    const written = await readBlob(blob as unknown as Blob);
    expect(written).toContain('Password: S3cret-pass');
    expect(written).toContain('Username: kiran');
    expect((blob as unknown as Blob).type).toContain('text/plain');
    expect(screen.getByText(t('saveText.done'))).toBeTruthy();
    expect(calls).toEqual([]);
  });
});

describe('the Office setup screen', () => {
  it('offers the paired Master, its address and this panel in the file', async () => {
    configureUi({ panel: 'office', defaultTheme: 'light', themeStorageKey: 'ob.theme' });
    const path = '../../office/web/src/screens/SetupScreen.tsx';
    const { SetupScreen } = (await import(/* @vite-ignore */ path)) as {
      SetupScreen: ComponentType<Record<string, unknown>>;
    };
    let blob: Blob | null = null;
    URL.createObjectURL = vi.fn((made: Blob | MediaSource) => {
      blob = made as Blob;
      return 'blob:x';
    });
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    (globalThis as { __APP_VERSION__?: string }).__APP_VERSION__ = '1.4.3';

    render(
      <SetupScreen
        connection={{
          hasNetworkLink: true, interfaces: [], isPaired: true, panelName: 'Reception PC', state: 'connected',
          masterHost: '192.168.1.10', masterPort: 4100, companyName: 'Shree Ceramics', lastError: null,
          lastSyncedAt: '2026-10-05T09:00:00.000Z', masterVersion: '1.4.3', deviceCode: 'D4497C',
        }}
        result={null}
        onContinue={() => undefined}
        onLeft={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: t('saveText.button') }));

    const written = await readBlob(blob as unknown as Blob);
    expect(written).toContain('Office Panel setup');
    expect(written).toContain('Company: Shree Ceramics');
    expect(written).toContain('Master address: 192.168.1.10:4100');
    expect(written).toContain('Master version: 1.4.3');
    expect(written).toContain('Panel name: Reception PC');
    expect(written).toContain('Device code: D4497C');
  });
});

describe('every screen that shows a value once offers Save to .txt', () => {
  const root = process.cwd();
  const cases: Array<[string, RegExp]> = [
    ['master/web/src/screens/FirstRunScreen.tsx', /slug="first-run"[\s\S]*slug="pairing-password"/],
    ['master/web/src/screens/ServerMasterSetupFlow.tsx', /slug="server-masters"/],
    ['master/web/src/screens/MasterKeyRecoveryFlow.tsx', /slug="password-reset"/],
    ['master/web/src/screens/AccessScreen.tsx', /slug="password"/],
    ['master/web/src/screens/IntegrationsScreen.tsx', /slug="api-token"/],
    ['master/web/src/screens/SettingsScreen.tsx', /slug="pairing-password"/],
    ['master/web/src/components/StorageBackup.tsx', /slug="pairing-password"/],
    ['office/web/src/screens/SetupScreen.tsx', /slug="office-setup"/],
  ];

  it.each(cases)('%s', (file, pattern) => {
    const source = readFileSync(join(root, file), 'utf8');
    expect(source).toContain('<SaveTextButton');
    expect(source).toMatch(pattern);
  });
});
