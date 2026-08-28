/**
 * Appearance state: theme, density and the motion kill switch (§5, §10).
 *
 * All three live on <html> as data attributes and persist in localStorage —
 * per machine, never synced. CSS reads only these attributes; no component
 * needs to know a theme or density exists beyond offering the toggle.
 */

import { uiConfig, type Theme } from './config.js';

export type { Theme };
export type Density = 'compact' | 'comfortable' | 'large';

// The theme key and default are per-panel and live in `config.ts`; these two
// are the same everywhere.
const KEY_DENSITY = 'ob.density';
const KEY_MOTION = 'ob.motion';

export function read<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = window.localStorage.getItem(key);
    return value !== null && (allowed as readonly string[]).includes(value)
      ? (value as T)
      : fallback;
  } catch {
    return fallback;
  }
}

/**
 * The panel's configured default unless this machine says otherwise. The
 * Master's chrome is dark so it is unmistakable from an Office Panel at a
 * glance when both sit open on a desk; office keeps the light default.
 * `index.html` ships the same value on <html> so the right ramp is already in
 * place before this runs.
 */
export function loadTheme(): Theme {
  const { themeStorageKey, defaultTheme } = uiConfig();
  return read<Theme>(themeStorageKey, ['light', 'dark'], defaultTheme);
}

export function loadDensity(): Density {
  return read<Density>(KEY_DENSITY, ['compact', 'comfortable', 'large'], 'comfortable');
}

/** True when animation is switched off in settings. The OS-level
 * prefers-reduced-motion setting is honoured by CSS, not here. */
export function motionDisabled(): boolean {
  return read(KEY_MOTION, ['on', 'off'], 'on') === 'off';
}

export function store(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private-browsing modes refuse localStorage; the attribute still applies,
    // it just will not survive a restart.
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  // Scrollbars, native select popups and autofill are painted by the browser
  // from `color-scheme`, not from the token ramp, so they follow the OS unless
  // the root states which scheme the page is actually using — a light scrollbar
  // down the side of a dark shell otherwise. `index.html` carries the same
  // value inline so the first painted frame already agrees.
  document.documentElement.style.colorScheme = theme;
  store(uiConfig().themeStorageKey, theme);
}

export function applyDensity(density: Density): void {
  document.documentElement.dataset.density = density;
  store(KEY_DENSITY, density);
}

export function applyMotion(motionOn: boolean): void {
  document.documentElement.dataset.motion = motionOn ? 'on' : 'off';
  store(KEY_MOTION, motionOn ? 'on' : 'off');
}

/** Called once before first paint so there is no flash of the wrong theme. */
export function initAppearance(): void {
  applyTheme(loadTheme());
  applyDensity(loadDensity());
  applyMotion(!motionDisabled());
}
