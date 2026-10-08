/**
 * Basic Home: one tile per sidebar module, in the sidebar's groups, with the
 * chord the person has actually bound, and nothing for a module they cannot
 * open. Also where people land after signing in.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BINDINGS_STORAGE_KEY } from '@orderbook/shared';

import type { NavGroup } from '../src/AppShell.js';
import { BasicHome, landingScreen } from '../src/BasicHome.js';
import { KeyboardProvider } from '../src/KeyboardProvider.js';
import { t } from '../src/i18n.js';
import { TILE_ICONS } from '../src/tileIcons.js';

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

  it('draws every tile as its colour art or, with none, the line icon on a plain face', () => {
    home({
      onNewLead: () => undefined,
      groups: [
        ...groups,
        // Every shipped module has art now, so a module added later without any stands in here.
        { label: 'Admin', items: [{ id: 'futureModule', label: 'Future module', icon: 'noticeEdit' }] },
      ],
    });
    const tiles = screen.getAllByRole('button').filter((button) => button.classList.contains('ob-tile'));
    expect(tiles.length).toBe(7);
    for (const button of tiles) {
      const id = button.getAttribute('data-tile')!;
      const face = button.querySelector('.ob-tile-face')!;
      const art = TILE_ICONS[id as keyof typeof TILE_ICONS];
      expect(face.classList.contains('ob-tile-face--art'), id).toBe(Boolean(art));
      expect(face.querySelector('svg')?.getAttribute('viewBox'), id).toBe(art ? '0 0 96 96' : '0 0 24 24');
    }
    expect(TILE_ICONS.newLead).toBeDefined();
    expect(tile('Future module').querySelector('.ob-tile-face--art')).toBeNull();
  });

  it('offers New Order first in Work only when it is given', () => {
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

describe('Basic Home’s top row (2026-10-08, "in less space")', () => {
  const css = () => readFileSync(join(process.cwd(), 'ui', 'src', 'base.css'), 'utf8');
  const rule = (selector: string) => {
    const text = css();
    const start = text.indexOf(`${selector} {`);
    return start < 0 ? '' : text.slice(start, text.indexOf('}', start));
  };

  it('sets the notice band and the product band side by side where both fit, stacked below that', () => {
    expect(rule('.ob-home-bands')).toContain('grid-template-columns: repeat(auto-fit, minmax(min(100%, 34rem), 1fr))');
  });

  it('keeps both bands one short row: 8 px top and bottom, a 56 px photo', () => {
    expect(rule('.ob-slideshow')).toContain('padding: var(--s-8) var(--s-12) var(--s-8) var(--s-16)');
    expect(rule('.ob-prodshow')).toContain('padding: var(--s-8) var(--s-12) var(--s-8) var(--s-16)');
    expect(rule('.ob-prodshow-photo')).toContain('height: 4rem');
  });

  it('is laid out the same way by both panels', () => {
    for (const panel of ['master', 'office']) {
      const app = readFileSync(join(process.cwd(), panel, 'web', 'src', 'App.tsx'), 'utf8');
      expect(app).toContain('<div className="ob-home-bands ob-measure-wide">');
      expect(app).toContain('<ProductSlideshow');
    }
  });
});
