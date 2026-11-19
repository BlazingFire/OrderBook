/**
 * Basic Home's Tile size (owner, 2026-11-19): a slider with minus and plus, applied live, kept
 * only when Save is pressed, and kept for each signed-in user apart.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { NavGroup } from '../src/AppShell.js';
import { BasicHome, readTileScale, tileScaleKey } from '../src/BasicHome.js';
import { KeyboardProvider } from '../src/KeyboardProvider.js';
import { t } from '../src/i18n.js';

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

const GROUPS: NavGroup[] = [
  { label: 'Work', items: [{ id: 'dashboard', label: 'Dashboard', icon: 'dashboard' }] },
];

function mount(userId?: string) {
  return render(
    <KeyboardProvider panel="office">
      <BasicHome groups={GROUPS} onOpen={() => undefined} userId={userId} />
    </KeyboardProvider>,
  );
}

const launcherScale = () =>
  (document.querySelector('.ob-launcher') as HTMLElement).style.getPropertyValue('--ob-tile-scale');

describe('Basic Home tile size', () => {
  it('previews on plus and minus, and keeps it only after Save', () => {
    mount('u1');
    const save = screen.getByRole('button', { name: t('basicHome.tileSave') }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(launcherScale()).toBe('1');

    fireEvent.click(screen.getByRole('button', { name: t('basicHome.tileLarger') }));
    fireEvent.click(screen.getByRole('button', { name: t('basicHome.tileLarger') }));
    expect(launcherScale()).toBe('1.2');
    expect(save.disabled).toBe(false);
    expect(window.localStorage.getItem(tileScaleKey('u1'))).toBeNull();

    fireEvent.click(save);
    expect(window.localStorage.getItem(tileScaleKey('u1'))).toBe('120');
    expect(save.disabled).toBe(true);
  });

  it('moves with the slider and stops at its ends', () => {
    mount('u1');
    const slider = screen.getByRole('slider', { name: t('basicHome.tileSize') });
    fireEvent.change(slider, { target: { value: '60' } });
    expect(launcherScale()).toBe('0.6');
    expect(
      (screen.getByRole('button', { name: t('basicHome.tileSmaller') }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("keeps each user's size apart, and reads a garbled value as the default", () => {
    window.localStorage.setItem(tileScaleKey('u1'), '140');
    window.localStorage.setItem(tileScaleKey('u2'), 'banana');
    expect(readTileScale('u1')).toBe(140);
    expect(readTileScale('u2')).toBe(100);
    expect(readTileScale(undefined)).toBe(100);

    const view = mount('u1');
    expect(launcherScale()).toBe('1.4');
    view.rerender(
      <KeyboardProvider panel="office">
        <BasicHome groups={GROUPS} onOpen={() => undefined} userId="u2" />
      </KeyboardProvider>,
    );
    expect(launcherScale()).toBe('1');
  });

  it('offers no Save without a signed-in user to keep it for', () => {
    mount();
    expect(screen.queryByRole('button', { name: t('basicHome.tileSave') })).toBeNull();
  });
});
