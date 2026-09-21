/**
 * A module's sub-pages — its tabs, views or slices — offered from the sidebar
 * as well as from the screen itself (§8). A child id is `<module>.<key>`; the
 * shell keeps the chosen key per module and hands it to the screen, so the
 * sidebar and the screen's own control always agree.
 */

import type { NavItem } from './AppShell.js';
import type { IconName } from './icons.js';

export interface SubPage {
  key: string;
  label: string;
  icon: IconName;
}

export function subPageItems(module: string, pages: readonly SubPage[]): NavItem[] {
  return pages.map((page) => ({ id: `${module}.${page.key}`, label: page.label, icon: page.icon }));
}

/** A child id back into its module and key; null for a module id. */
export function splitSubPage(id: string): { module: string; key: string } | null {
  const dot = id.indexOf('.');
  return dot > 0 ? { module: id.slice(0, dot), key: id.slice(dot + 1) } : null;
}

/** Hangs each module's sub-pages under it, leaving modules without any alone. */
export function withSubPages(
  items: NavItem[],
  pages: Record<string, readonly SubPage[] | undefined>,
): NavItem[] {
  return items.map((item) => {
    const own = pages[item.id];
    return own && own.length > 0 ? { ...item, children: subPageItems(item.id, own) } : item;
  });
}
