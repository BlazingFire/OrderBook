/**
 * The shell both panels render (§8):
 *
 *   rail │ sidebar │ topbar
 *        │         │ content — scrolls; nothing else scrolls
 *        │         │ status footer 26px
 *
 * Overlays (the palette, popovers, dialogs) render inside `.ob-main` so they
 * anchor to the working area rather than the window.
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import { t } from './i18n.js';
import { Icon, type IconName } from './icons';
import { useCommand } from './KeyboardProvider.js';
import { Logo } from './Logo';
import { PresenceRail, type RailState } from './PresenceRail';

export interface NavItem {
  id: string;
  label: string;
  icon: IconName;
  count?: number;
  /**
   * Nested entries: a module's sub-pages (Documents → Templates / Exports) or
   * a large operation opened out of it — editing a role, an open record. An
   * item with children shows a chevron and folds; it unfolds on its own while
   * the current page is inside it.
   */
  children?: NavItem[];
}

function contains(item: NavItem, id: string): boolean {
  return item.id === id || (item.children?.some((child) => contains(child, id)) ?? false);
}

/** Every item at every depth, in sidebar order. */
export function flattenNav(items: NavItem[]): NavItem[] {
  return items.flatMap((item) => [item, ...flattenNav(item.children ?? [])]);
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export function AppShell({
  groups,
  activeId,
  onNavigate,
  collapsed,
  onToggleCollapsed,
  topbar,
  filterbar,
  footer,
  rail,
  railLabel,
  onRailClick,
  overlays,
  children,
}: {
  groups: NavGroup[];
  activeId: string;
  onNavigate: (id: string) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  topbar: ReactNode;
  /** The strip under the topbar — list screens only (§8). Omit elsewhere. */
  filterbar?: ReactNode;
  footer: ReactNode;
  rail: RailState;
  railLabel: string;
  onRailClick: () => void;
  overlays?: ReactNode;
  children: ReactNode;
}) {
  // Folds the operator has set by hand; anything unset follows the current page.
  const [folded, setFolded] = useState<Record<string, boolean>>({});

  /*
   * Ctrl+\ and the palette's "Toggle sidebar" run the same toggle as the
   * button at the foot of the sidebar. Registered here, where that toggle is
   * already in hand, so both panels answer the command without a shell entry
   * in each `App.tsx` — and nothing but `collapsed` decides what the sidebar
   * shows.
   */
  useCommand('view.toggleSidebar', onToggleCollapsed);

  function renderNavItem(item: NavItem, depth: number) {
    const hasChildren = Boolean(item.children?.length);
    const open = hasChildren && (folded[item.id] ?? !contains(item, activeId)) === false;
    return (
      <div key={item.id} className="ob-navitem-wrap">
        <div className={depth ? 'ob-navitem ob-navitem--child' : 'ob-navitem'}>
          <button
            type="button"
            className="ob-navitem-main"
            aria-current={activeId === item.id ? 'page' : undefined}
            title={item.label}
            onClick={() => {
              onNavigate(item.id);
              if (hasChildren) setFolded((current) => ({ ...current, [item.id]: false }));
            }}
          >
            <Icon name={item.icon} size={depth ? 14 : 16} />
            {!collapsed && <span className="ob-navitem-label">{item.label}</span>}
            {!collapsed && item.count ? <span className="count">{item.count}</span> : null}
          </button>
          {!collapsed && hasChildren && (
            <button
              type="button"
              className="ob-navitem-fold"
              aria-label={open ? t('nav.fold') : t('nav.unfold')}
              aria-expanded={open}
              onClick={() => setFolded((current) => ({ ...current, [item.id]: open }))}
            >
              <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
            </button>
          )}
        </div>
        {/* Collapsed to icons there is no indent to read a child by, and no
            label to say what it is — so a collapsed sidebar shows modules only. */}
        {!collapsed && open && (
          <div className="ob-navitem-children">
            {item.children!.map((child) => renderNavItem(child, depth + 1))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="ob-shell">
      <PresenceRail state={rail} label={railLabel} onClick={onRailClick} />

      <nav
        className={collapsed ? 'ob-sidebar ob-sidebar--collapsed' : 'ob-sidebar'}
        aria-label={t('nav.modules')}
      >
        <button
          type="button"
          className="ob-sidebar-brand"
          title={t('nav.home')}
          aria-label={t('nav.home')}
          onClick={() => onNavigate('dashboard')}
        >
          <Logo size={24} />
          {!collapsed && <span className="ob-sidebar-wordmark">{t('app.name')}</span>}
        </button>

        <div className="ob-sidebar-nav">
          {groups.map((group) => (
            <div className="ob-navgroup" key={group.label}>
              {!collapsed && <div className="ob-navgroup-label ob-eyebrow">{group.label}</div>}
              {group.items.map((item) => renderNavItem(item, 0))}
            </div>
          ))}
        </div>

        <button
          type="button"
          className="ob-sidebar-collapse"
          aria-label={collapsed ? t('nav.expandSidebar') : t('nav.collapseSidebar')}
          onClick={onToggleCollapsed}
        >
          {collapsed ? (
            <Icon name="expand" size={12} />
          ) : (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Icon name="collapse" size={12} /> {t('nav.collapse')}
            </span>
          )}
        </button>
      </nav>

      <div className="ob-main">
        <header className="ob-topbar">{topbar}</header>
        {filterbar}
        <main className="ob-content">{children}</main>
        <footer className="ob-footer">{footer}</footer>
        {overlays}
      </div>
    </div>
  );
}
