/**
 * Page controls for a long list (1.4.3 R17): the range on screen out of the total, a page size, and
 * First / Previous / Next / Last. Used by the Pending and Final Orders lists on both panels.
 *
 * The page size is remembered per machine under its own key (`ob.pageSize.<list>`), never synced,
 * and an unknown stored value falls back to the default instead of failing.
 */

import { useCallback, useState } from 'react';

import { Button } from './Button.js';
import { t } from './i18n.js';
import { Select } from './SuggestInput.js';

export const PAGE_SIZES = [25, 50, 100, 200, 500] as const;
export const DEFAULT_PAGE_SIZE = 50;

export interface PageWindow {
  /** The page to show, clamped into range (0-based). */
  page: number;
  pages: number;
  /** 1-based position of the first and last row on this page; 0 when there is nothing. */
  from: number;
  to: number;
  offset: number;
}

/** Where `page` lands for `total` rows of `size` per page. Pure, so the boundaries are tested without a screen. */
export function pageWindow(total: number, page: number, size: number): PageWindow {
  const safeSize = Math.max(1, Math.floor(size));
  const safeTotal = Math.max(0, Math.floor(total));
  const pages = Math.max(1, Math.ceil(safeTotal / safeSize));
  const clamped = Math.min(Math.max(0, Math.floor(page)), pages - 1);
  const offset = clamped * safeSize;
  return {
    page: clamped,
    pages,
    offset,
    from: safeTotal === 0 ? 0 : offset + 1,
    to: Math.min(safeTotal, offset + safeSize),
  };
}

function readSize(storageKey: string): number {
  try {
    const stored = Number(window.localStorage.getItem(storageKey));
    return (PAGE_SIZES as readonly number[]).includes(stored) ? stored : DEFAULT_PAGE_SIZE;
  } catch {
    return DEFAULT_PAGE_SIZE;
  }
}

/** The chosen page size for one list, kept on this machine. */
export function usePageSize(list: string): [number, (size: number) => void] {
  const storageKey = `ob.pageSize.${list}`;
  const [size, setSize] = useState(() => readSize(storageKey));
  const choose = useCallback(
    (next: number) => {
      if (!(PAGE_SIZES as readonly number[]).includes(next)) return;
      setSize(next);
      try {
        window.localStorage.setItem(storageKey, String(next));
      } catch {
        // Storage unavailable: the choice lasts for this visit.
      }
    },
    [storageKey],
  );
  return [size, choose];
}

interface PageBarProps {
  total: number;
  page: number;
  pageSize: number;
  onPage: (page: number) => void;
  onPageSize: (size: number) => void;
  /** A page is on its way: the controls stay, and say so to assistive technology. */
  loading?: boolean;
}

export function PageBar({ total, page, pageSize, onPage, onPageSize, loading }: PageBarProps) {
  const window_ = pageWindow(total, page, pageSize);
  const first = window_.page === 0;
  const last = window_.page >= window_.pages - 1;

  return (
    <nav
      aria-label={t('pageBar.label')}
      aria-busy={loading ? true : undefined}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: 'var(--s-12)',
        padding: 'var(--s-8) 0',
      }}
    >
      <span className="ob-small" role="status" aria-live="polite">
        {total === 0
          ? t('pageBar.none')
          : t('pageBar.range', { from: window_.from, to: window_.to, total })}
      </span>

      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-8)', flexWrap: 'wrap' }}>
        <label className="ob-small" style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-6)' }}>
          {t('pageBar.perPage')}
          <Select
            value={String(pageSize)}
            aria-label={t('pageBar.perPage')}
            onChange={(event) => onPageSize(Number(event.target.value))}
          >
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </Select>
        </label>

        <Button size="sm" variant="secondary" disabled={first} onClick={() => onPage(0)} aria-label={t('pageBar.first')}>
          «
        </Button>
        <Button size="sm" variant="secondary" disabled={first} onClick={() => onPage(window_.page - 1)}>
          {t('pageBar.previous')}
        </Button>
        <span className="ob-small" aria-label={t('pageBar.pageOf', { page: window_.page + 1, pages: window_.pages })}>
          {t('pageBar.pageOf', { page: window_.page + 1, pages: window_.pages })}
        </span>
        <Button size="sm" variant="secondary" disabled={last} onClick={() => onPage(window_.page + 1)}>
          {t('pageBar.next')}
        </Button>
        <Button size="sm" variant="secondary" disabled={last} onClick={() => onPage(window_.pages - 1)} aria-label={t('pageBar.last')}>
          »
        </Button>
      </span>
    </nav>
  );
}
