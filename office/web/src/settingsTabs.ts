/**
 * The Settings tabs, kept apart from `SettingsScreen.tsx` so the shell can
 * build the sidebar's Settings fold without loading that screen: it is loaded
 * on first visit.
 */
export const SETTINGS_TAB_IDS = [
  'appearance',
  'shortcuts',
  'leads',
  'machine',
  'storage',
] as const;
