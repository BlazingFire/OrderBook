/**
 * Appearance state: theme and the motion kill switch (§5, §10).
 *
 * Both live on <html> as data attributes and persist in localStorage —
 * per machine, never synced. CSS reads only these attributes; no component
 * needs to know a theme exists beyond offering the toggle.
 */

import { uiConfig, type Theme } from './config.js';

export type { Theme };

// The theme key and default are per-panel and live in `config.ts`; these
// are the same everywhere.
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

/**
 * The scale to start at when the operator has not chosen one: 150 % on a 4K
 * screen at 100-125 % Windows scaling (3000+ device pixels across at a device
 * pixel ratio under 1.5), where the 14 px root reads as tiny; 100 % on
 * everything else, 1080p and 1440p included. The owner's rule, 2026-10-07.
 */
export function screenDefaultScale(screenWidth: number, devicePixelRatio: number): number {
  const ratio = devicePixelRatio > 0 ? devicePixelRatio : 1;
  return screenWidth * ratio >= 3000 && ratio < 1.5 ? SCALE_DEFAULT * 1.5 : SCALE_DEFAULT;
}

function screenDefault(): number {
  try {
    return screenDefaultScale(window.screen?.width ?? 0, window.devicePixelRatio || 1);
  } catch {
    return SCALE_DEFAULT;
  }
}

export function loadScale(): number {
  try {
    const raw = window.localStorage.getItem(KEY_SCALE);
    const parsed = raw === null ? NaN : Number(raw);
    return Number.isFinite(parsed) ? clampScale(parsed) : screenDefault();
  } catch {
    return screenDefault();
  }
}

/**
 * `remember` is false only for the boot-time apply: storing there would turn
 * the screen default into a saved choice, and a later move to another screen
 * would not change it. A scale the operator picks is stored and always wins.
 */
export function applyScale(px: number, remember = true): void {
  const value = clampScale(px);
  // Set on the element rather than in a stylesheet: `html { font-size:
  // var(--root-size) }` in tokens.css reads it, so this one assignment
  // resizes everything, live, with no reflow of the token layer.
  document.documentElement.style.setProperty('--root-size', `${value}px`);
  if (remember) store(KEY_SCALE, String(value));
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
  // down the side of a dark shell otherwise. The Master's `index.html` carries
  // `color-scheme: dark` inline so its first painted frame already agrees; the
  // Office's does not, so until this runs its scrollbars follow the OS, through
  // the `<meta name="color-scheme" content="light dark">` both pages ship.
  document.documentElement.style.colorScheme = theme;
  store(uiConfig().themeStorageKey, theme);
}

export function applyMotion(motionOn: boolean): void {
  document.documentElement.dataset.motion = motionOn ? 'on' : 'off';
  store(KEY_MOTION, motionOn ? 'on' : 'off');
}

/** Called once before first paint so there is no flash of the wrong theme. */
export function initAppearance(): void {
  applyTheme(loadTheme());
  applyScale(loadScale(), false);
  applyMotion(!motionDisabled());
}
