/**
 * SwipeActions: touch-first rows with leading/trailing actions under the edges.
 * Pointer tracking on rAF springs (transform only), rubber-band overscroll,
 * full-swipe commit, and — always — a "More actions" menu with the same actions
 * so mouse and keyboard users never need the gesture.
 *
 * Desktop-first tables keep RowActions; use this for triage lists (chat rooms,
 * print jobs, notices, tasks) where thumbs do the work.
 */

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { Icon, type IconName } from './icons.js';
import { t } from './i18n.js';
import { Popover } from './Popover.js';

export interface SwipeAction {
  label: string;
  icon: IconName;
  tone?: 'neutral' | 'accent' | 'danger';
  keepRow?: boolean;
  onSelect: () => void;
}

export function SwipeActions({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <ul
      role="list"
      aria-label={label}
      className={['ob-swipe-list', className].filter(Boolean).join(' ')}
      style={{ listStyle: 'none', margin: 0, padding: 0 }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setOpenId(null);
      }}
    >
      {children}
    </ul>
  );
  void openId;
}

export function SwipeActionsRow({
  label,
  leading = [],
  trailing = [],
  fullSwipe = true,
  onOpenChange,
  children,
  className,
}: {
  label: string;
  leading?: SwipeAction[];
  trailing?: SwipeAction[];
  fullSwipe?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
  className?: string;
}) {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const face = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ startX: number; base: number; locked: boolean; id: number } | null>(null);
  const settled = useRef(0);
  const actions = [...leading, ...trailing];

  const stops = (): { left: number; right: number } => {
    const width = face.current?.offsetWidth ?? 320;
    const unit = 76;
    return {
      left: leading.length > 0 ? Math.min(leading.length * unit, width * 0.6) : 0,
      right: trailing.length > 0 ? Math.min(trailing.length * unit, width * 0.6) : 0,
    };
  };

  const commit = (side: 'leading' | 'trailing'): void => {
    const list = side === 'leading' ? leading : trailing;
    const action = side === 'leading' ? list[0] : list[list.length - 1];
    action?.onSelect();
    if (!action?.keepRow) return;
    settled.current = 0;
    setOffset(0);
  };

  useEffect(() => {
    onOpenChange?.(offset !== 0);
  }, [offset, onOpenChange]);

  const onPointerDown = (event: React.PointerEvent): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    gesture.current = { startX: event.clientX, base: settled.current, locked: false, id: event.pointerId };
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent): void => {
    const g = gesture.current;
    if (!g || g.id !== event.pointerId) return;
    const delta = event.clientX - g.startX;
    if (!g.locked && Math.abs(delta) < 8) return;
    g.locked = true;
    setDragging(true);
    const { left, right } = stops();
    const maxLeft = left + 48;
    const maxRight = right + 48;
    const next = Math.max(-maxRight, Math.min(maxLeft, g.base + delta));
    // Rubber-band past the stops.
    const clamped =
      next > left ? left + (next - left) * 0.35 : next < -right ? -right + (next + right) * 0.35 : next;
    setOffset(clamped);
  };

  const onPointerUp = (event: React.PointerEvent): void => {
    const g = gesture.current;
    gesture.current = null;
    if (!g || g.id !== event.pointerId) return;
    setDragging(false);
    if (!g.locked) return;
    const { left, right } = stops();
    const width = face.current?.offsetWidth ?? 320;
    const threshold = Math.max(Math.max(left, right) + 48, width * 0.56);
    if (fullSwipe && ((offset > 0 && offset >= threshold && leading.length > 0) || (offset < 0 && -offset >= threshold && trailing.length > 0))) {
      commit(offset > 0 ? 'leading' : 'trailing');
      return;
    }
    const rest = offset > 8 && left > 0 ? left : offset < -8 && right > 0 ? -right : 0;
    settled.current = rest;
    setOffset(rest);
  };

  return (
    <li className={['ob-swipe', className].filter(Boolean).join(' ')}>
      {leading.length > 0 ? (
        <span className="ob-swipe-actions ob-swipe-actions--leading" aria-hidden="true">
          {leading.map((action) => (
            <button
              key={action.label}
              type="button"
              tabIndex={-1}
              className={`ob-swipe-action ob-swipe-action--${action.tone ?? 'neutral'}`}
              style={{ width: 76 }}
              onClick={() => action.onSelect()}
            >
              <Icon name={action.icon} size={18} />
              <span>{action.label}</span>
            </button>
          ))}
        </span>
      ) : null}
      {trailing.length > 0 ? (
        <span className="ob-swipe-actions" aria-hidden="true">
          {trailing.map((action) => (
            <button
              key={action.label}
              type="button"
              tabIndex={-1}
              className={`ob-swipe-action ob-swipe-action--${action.tone ?? 'neutral'}`}
              style={{ width: 76 }}
              onClick={() => action.onSelect()}
            >
              <Icon name={action.icon} size={18} />
              <span>{action.label}</span>
            </button>
          ))}
        </span>
      ) : null}
      <div
        ref={face}
        className={`ob-swipe-face${dragging ? ' ob-swipe-face--drag' : ''}`}
        style={{ transform: offset === 0 ? undefined : `translateX(${offset}px)` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {children}
        {actions.length > 0 ? (
          <span className="ob-swipe-more">
            <button
              type="button"
              className="ob-icon-btn"
              aria-label={t('common.moreActions', { label })}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={(event) => {
                event.stopPropagation();
                setMenuOpen((value) => !value);
              }}
            >
              <Icon name="more" size={16} />
            </button>
            <Popover open={menuOpen} onClose={() => setMenuOpen(false)}>
              <div role="menu" aria-label={t('common.moreActions', { label })}>
                {actions.map((action) => (
                  <button
                    key={action.label}
                    type="button"
                    role="menuitem"
                    className="ob-usermenu-row"
                    onClick={() => {
                      setMenuOpen(false);
                      action.onSelect();
                    }}
                  >
                    <Icon name={action.icon} size={16} />
                    <span>{action.label}</span>
                  </button>
                ))}
              </div>
            </Popover>
          </span>
        ) : null}
      </div>
    </li>
  );
}
