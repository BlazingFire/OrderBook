/**
 * Basic Home: one tile per sidebar module, in the sidebar's groups, with the
 * chord the person has actually bound, and nothing for a module they cannot
 * open. Also where people land after signing in.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BINDINGS_STORAGE_KEY } from '@orderbook/shared';

import type { NavGroup } from '../src/AppShell.js';
import { BasicHome, landingScreen } from '../src/BasicHome.js';
import { KeyboardProvider } from '../src/KeyboardProvider.js';
import { t } from '../src/i18n.js';

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

const groups: NavGroup[] = [
  {
    label: 'Work',
    items: [
      { id: 'basicHome', label: 'Basic Home', icon: 'home' },
      { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
      { id: 'leads', label: 'Pending Orders', icon: 'leads', count: 3 },
      { id: 'reports', label: 'Reports', icon: 'report' },
    ],
  },
  { label: 'Catalogue', items: [{ id: 'products', label: 'Products', icon: 'products' }] },
  { label: 'System', items: [{ id: 'settings', label: 'Settings', icon: 'settings' }] },
];

function home(props: Partial<Parameters<typeof BasicHome>[0]> = {}) {
  const onOpen = vi.fn();
  render(
    <KeyboardProvider panel="office">
      <BasicHome groups={groups} onOpen={onOpen} {...props} />
    </KeyboardProvider>,
  );
  return onOpen;
}

function tile(name: string): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(`^${name}`) });
}

describe('BasicHome', () => {
  it('draws a section per group and a tile per module, except itself', () => {
    home();
    expect(
      screen.getAllByRole('region').map((section) => section.getAttribute('aria-label')),
    ).toEqual(['Work', 'Catalogue', 'System']);
    const work = within(screen.getByRole('region', { name: 'Work' }));
    expect(
      work
        .getAllByRole('button')
        .map((button) => button.querySelector('.ob-tile-label')?.textContent),
    ).toEqual(['Dashboard', 'Pending Orders', 'Reports']);
  });

  it('opens the module a tile stands for', () => {
    const onOpen = home();
    fireEvent.click(tile('Products'));
    expect(onOpen).toHaveBeenCalledWith('products');
  });

  it('has no tile for a module the groups leave out — absent, not disabled', () => {
    home({
      groups: [
        { label: 'Work', items: [{ id: 'dashboard', label: 'Dashboard', icon: 'dashboard' }] },
      ],
    });
    expect(screen.queryByText('Products')).toBeNull();
    expect(screen.queryByText('Settings')).toBeNull();
  });

  it('shows the chord each module answers to', () => {
    home();
    expect(tile('Dashboard').querySelector('.ob-tile-chord')?.textContent).toBe('Alt+2');
    expect(tile('Settings').querySelector('.ob-tile-chord')?.textContent).toBe('Alt+9');
    expect(tile('Settings').getAttribute('aria-keyshortcuts')).toBe('Alt+9');
    // Reports takes a letter chord (1.4 R13), so its tile carries one too.
    expect(tile('Reports').querySelector('.ob-tile-chord')?.textContent).toBe('Alt+R');
  });

  it('follows the person’s own bindings, and hides a chip they cleared', () => {
    window.localStorage.setItem(
      BINDINGS_STORAGE_KEY,
      JSON.stringify({ 'nav.office.dashboard': null, 'nav.office.settings': 'Ctrl+Shift+E' }),
    );
    home();
    expect(tile('Dashboard').querySelector('.ob-tile-chord')).toBeNull();
    expect(tile('Settings').querySelector('.ob-tile-chord')?.textContent).toBe('Ctrl+Shift+E');
  });

  it('puts a count badge on a module that has one', () => {
    home();
    expect(tile('Pending Orders').querySelector('.ob-tile-count')?.textContent).toBe('3');
    expect(tile('Dashboard').querySelector('.ob-tile-count')).toBeNull();
  });

  it('offers New pending order first in Work only when it is given', () => {
    home();
    expect(screen.queryByText(t('basicHome.newLead'))).toBeNull();
    cleanup();

    const onNewLead = vi.fn();
    home({ onNewLead });
    const work = within(screen.getByRole('region', { name: 'Work' }));
    const first = work.getAllByRole('button')[0]!;
    expect(first.textContent).toContain(t('basicHome.newLead'));
    expect(first.querySelector('.ob-tile-chord')?.textContent).toBe('Ctrl+Shift+N');
    fireEvent.click(first);
    expect(onNewLead).toHaveBeenCalledOnce();
  });

  it('says so when the role opens no module at all', () => {
    home({
      groups: [{ label: 'Work', items: [{ id: 'basicHome', label: 'Basic Home', icon: 'home' }] }],
    });
    expect(screen.getByText(t('shell.noModules'))).toBeTruthy();
  });
});

describe('landingScreen', () => {
  it('sends Office and Management to Basic Home and everyone else to the Dashboard', () => {
    expect(landingScreen('office')).toBe('basicHome');
    expect(landingScreen('management')).toBe('basicHome');
    expect(landingScreen('admin')).toBe('dashboard');
    expect(landingScreen('server_master')).toBe('dashboard');
    // A tier this build has never heard of gets the safe default.
    expect(landingScreen('something_new')).toBe('dashboard');
  });
});
