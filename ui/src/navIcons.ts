/**
 * One icon per module, for the sidebar and Basic Home alike (1.4 R18): the same
 * flat line drawing, 16 px in the sidebar and larger on the tile. No two
 * modules share an icon. Both panels build their nav from this map;
 * `nav-icons.test.tsx` holds the line.
 */

import type { IconName } from './icons';

export const NAV_ICONS = {
  basicHome: 'home',
  dashboard: 'dashboard',
  leads: 'leads',
  orders: 'final',
  conflicts: 'conflicts',
  notices: 'notice',
  noticesManage: 'noticeEdit',
  chatroom: 'chat',
  printroom: 'print',
  reports: 'report',
  products: 'products',
  parties: 'parties',
  partyAccess: 'shield',
  lists: 'task',
  panels: 'server',
  access: 'people',
  fields: 'fields',
  logs: 'log',
  recycleBin: 'trash',
  integrations: 'plug',
  settings: 'settings',
  updates: 'update',
} as const satisfies Record<string, IconName>;

export type NavIconId = keyof typeof NAV_ICONS;
