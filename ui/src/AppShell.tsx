/**
 * The Office Panel shell (§8):
 *
 *   rail │ sidebar │ topbar
 *        │         │ content — scrolls; nothing else scrolls
 *        │         │ status footer 26px
 *
 * Overlays (popover, drawer, toasts) render inside `.ob-main` so they anchor
 * to the working area rather than the window.
 */

import { Fragment } from 'react';
import type { ReactNode } from 'react';
import { t } from './i18n.js';
import { Icon, type IconName } from './icons';
import { Logo } from './Logo';
import { PresenceRail, type RailState } from './PresenceRail';

export interface NavItem {
  id: string;
  label: string;
  icon: IconName;
  count?: number;
  /**
   * One level of nesting, for a large operation opened out of this module —
   * editing a role, editing a person. Never a second static tier of modules:
   * the sidebar is a map of where you can go, and burying a module inside
   * another module makes it a worse one.
   */
  children?: NavItem[];
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
  /** The 40px strip under the topbar — list screens only (§8). Omit elsewhere. */
  filterbar?: ReactNode;
  footer: ReactNode;
  rail: RailState;
  railLabel: string;
  onRailClick: () => void;
  overlays?: ReactNode;
  children: ReactNode;
}) {
  function renderNavItem(item: NavItem, isChild: boolean) {
    return (
      <button
        key={item.id}
        type="button"
        className={isChild ? 'ob-navitem ob-navitem--child' : 'ob-navitem'}
        aria-current={activeId === item.id ? 'page' : undefined}
        title={item.label}
        onClick={() => onNavigate(item.id)}
      >
        <Icon name={item.icon} size={isChild ? 14 : 16} />
        {!collapsed && <span className="ob-navitem-label">{item.label}</span>}
        {!collapsed && item.count ? <span className="count">{item.count}</span> : null}
      </button>
    );
  }

  return (
    <div className="ob-shell">
      <PresenceRail state={rail} label={railLabel} onClick={onRailClick} />

      <nav
        className={collapsed ? 'ob-sidebar ob-sidebar--collapsed' : 'ob-sidebar'}
        aria-label="Modules"
      >
        <div className="ob-sidebar-brand">
          <Logo size={24} />
          {!collapsed && <span className="ob-sidebar-wordmark">{t('app.name')}</span>}
        </div>

        <div className="ob-sidebar-nav">
          {groups.map((group) => (
            <div className="ob-navgroup" key={group.label}>
              {!collapsed && <div className="ob-navgroup-label ob-eyebrow">{group.label}</div>}
              {group.items.map((item) => (
                <Fragment key={item.id}>
                  {renderNavItem(item, false)}
                  {/* Collapsed to icons there is no indent to read a child by,
                      and no label to say what it is — so a collapsed sidebar
                      shows modules only. The operation is still on screen. */}
                  {!collapsed && item.children?.map((child) => renderNavItem(child, true))}
                </Fragment>
              ))}
            </div>
          ))}
        </div>

        <button
          type="button"
          className="ob-sidebar-collapse"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={onToggleCollapsed}
        >
          {collapsed ? (
            <Icon name="expand" size={12} />
          ) : (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Icon name="collapse" size={12} /> Collapse
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
