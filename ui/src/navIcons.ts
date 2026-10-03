/**
 * One icon per module, for the sidebar and Basic Home alike (1.4 R18). Each is
 * the 16 px line version of the module's Basic Home drawing, and no two modules
 * share one. Both panels build their nav from this map; `nav-icons.test.ts`
 * holds the line.
 */

import type { IconName } from './icons';

export const NAV_ICONS = {
  basicHome: 'home',
  dashboard: 'dashboard',
  leads: 'leads',
  orders: 'orders',
  conflicts: 'conflicts',
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
  updates: 'updates',
} as const satisfies Record<string, IconName>;

export type NavIconId = keyof typeof NAV_ICONS;
