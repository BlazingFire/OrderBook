/**
 * The Settings tabs, kept apart from `SettingsScreen.tsx` so the shell can
 * read them without loading that screen: it is loaded on first visit.
 */

/**
 * Every tab this panel can have, including the one that needs a permission.
 *
 * The list is fixed rather than derived from the tabs actually built, because
 * the company tab waits for its rows, which arrive a tick after the screen
 * mounts: a remembered `company` validated against the tabs of that first tick
 * would be thrown away every single load. `SettingsPage` shows the first tab
 * while a remembered one has nothing to render, so nothing is left blank in
 * the meantime.
 */
export const SETTINGS_TAB_IDS = [
  'appearance',
  'shortcuts',
  'company',
  'leads',
  'connection',
  'storage',
] as const;

/** The tabs a person with these permissions is offered; the company's own need `settings.manage`. */
export function settingsTabIdsFor(permissions: readonly string[]): readonly string[] {
  return permissions.includes('settings.manage')
    ? SETTINGS_TAB_IDS
    : SETTINGS_TAB_IDS.filter((id) => id === 'appearance' || id === 'shortcuts');
}
