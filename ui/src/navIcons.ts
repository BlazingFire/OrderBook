/**
 * One icon per module, for the sidebar and Basic Home alike (1.4 R18).
 *
 * A module with a Basic Home drawing (`GLYPHS` in `navGlyphs.tsx`) shows that
 * same drawing in the sidebar, in one colour (`NavGlyph`), so the entry here is
 * only its fallback. A module without one shows this line icon on both, the
 * sidebar at 16 px and the tile at 40 px. No two modules share an icon. Both
 * panels build their nav from this map; `nav-icons.test.tsx` holds the line.
 */

import type { IconName } from './icons';

export const NAV_ICONS = {
  basicHome: 'home',
  dashboard: 'dashboard',
  leads: 'leads',
  orders: 'orders',
  conflicts: 'conflicts',
  notices: 'pin',
  noticesManage: 'edit',
  chatroom: 'chat',
  printroom: 'print',
  reports: 'report',
  products: 'products',
  parties: 'parties',
  partyAccess: 'shield',
  panels: 'server',
  access: 'key',
  fields: 'filter',
  logs: 'log',
  recycleBin: 'trash',
  integrations: 'plug',
  settings: 'settings',
  updates: 'sync',
} as const satisfies Record<string, IconName>;

export type NavIconId = keyof typeof NAV_ICONS;
