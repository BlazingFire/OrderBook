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
const KEY_SCALE = 'ob.scale';
const KEY_SIDEBAR = 'ob.sidebar';

/**
 * The UI scale range, in px of root font size.
 *
 * Everything in the app is either rem or reads a token that is, so this one
 * number resizes the whole interface. Shown to the operator as a percentage of
 * 14, which is 79% to 157%.
 */
export const SCALE_MIN = 11;
export const SCALE_MAX = 22;
export const SCALE_STEP = 0.5;
export const SCALE_DEFAULT = 14;

/** Whether the sidebar follows the window width or is pinned by the operator. */
export type SidebarMode = 'auto' | 'open' | 'closed';

const clampScale = (value: number): number =>
  Math.min(SCALE_MAX, Math.max(SCALE_MIN, value));

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

/**
 * The stored scale, or one migrated from whatever density this machine was
 * last using.
 *
 * Density used to carry the root size, so a machine set to Compact was also
 * asking for 13px text. Reading that across once keeps those machines looking
 * the way they did. `ob.density` is deliberately NOT cleared: density is still
 * a live, independent setting — it just governs row and control heights now.
 */
export function loadScale(): number {
  try {
    const raw = window.localStorage.getItem(KEY_SCALE);
    if (raw !== null) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) return clampScale(parsed);
    }
    return { compact: 13, comfortable: 14, large: 16 }[loadDensity()];
  } catch {
    return SCALE_DEFAULT;
  }
}

export function applyScale(px: number): void {
  const value = clampScale(px);
  // Set on the element rather than in a stylesheet: `html { font-size:
  // var(--root-size) }` in tokens.css reads it, so this one assignment
  // resizes everything, live, with no reflow of the token layer.
  document.documentElement.style.setProperty('--root-size', `${value}px`);
  store(KEY_SCALE, String(value));
}

export function loadSidebarMode(): SidebarMode {
  return read<SidebarMode>(KEY_SIDEBAR, ['auto', 'open', 'closed'], 'auto');
}

export function storeSidebarMode(mode: SidebarMode): void {
  store(KEY_SIDEBAR, mode);
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
  applyScale(loadScale());
  applyDensity(loadDensity());
  applyMotion(!motionDisabled());
}
