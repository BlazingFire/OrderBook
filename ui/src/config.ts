/**
 * The handful of things that genuinely differ between the two panels.
 *
 * `theme.ts` used to exist twice, once per panel, and the two copies had
 * drifted in three ways: the storage key (`ob.theme.v2` vs `ob.theme`), the
 * default theme (dark vs light), and whether `color-scheme` was set on the
 * root at all — office's copy omitted it, which is a bug rather than a
 * preference, so the shared version always sets it.
 *
 * The first two are real configuration, declared here instead of forking the
 * module. Both panels default to light since 1.3 (the Master was dark until
 * then); the Master's key is versioned and the Office's is not.
 */

export type PanelKind = 'master' | 'office';
export type Theme = 'light' | 'dark';

export interface UiConfig {
  panel: PanelKind;
  defaultTheme: Theme;
  /**
   * Versioned on the Master because `initAppearance()` stores whatever it
   * loads, so an unversioned key cannot tell a machine that was merely opened
   * under an older default from one whose owner deliberately picked that theme
   * in Settings — both hold the same string. Bumping the suffix scopes the
   * stored value to the default it was written against.
   */
  themeStorageKey: string;
}

const DEFAULT: UiConfig = {
  panel: 'master',
  defaultTheme: 'light',
  themeStorageKey: 'ob.theme.v3',
};

let current: UiConfig = DEFAULT;

/**
 * Call once, from the panel's `main.tsx`, above `initAppearance()`.
 *
 * No module in this package may call `uiConfig()` at module top level: the
 * barrel evaluates before `main.tsx`'s first statement, so a top-level read
 * would always see the default.
 */
export function configureUi(config: UiConfig): void {
  current = config;
}

export function uiConfig(): UiConfig {
  return current;
}
