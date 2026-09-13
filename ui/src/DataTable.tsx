/**
 * DataTable (§9.1) — the workhorse. Cursor pagination only, virtualized above
 * 100 rows (non-negotiable on 4GB machines, §11). Redacted fields render an
 * em dash with a tooltip naming the missing permission, and must cope with an
 * absent key (redaction removes the key — never assume `null`).
 */

import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { fitColumns, gridTemplateFor } from './fitColumns.js';

export interface DataTableColumn<T> {
  key: string;
  header: string;
  width?: string;
  align?: 'left' | 'right';
  render: (row: T) => ReactNode;
  /** Returns the missing-permission name when this cell is redacted for this row. */
  redactedReason?: (row: T) => string | undefined;
  /**
   * How willingly this column is dropped when the table runs out of room:
   * `3` first, then `2`, and `1` (or absent) never.
   *
   * Only set this on a table whose rows open a full record — see
   * `fitColumns.ts`. On a table that is the record, every column stays at 1.
   */
  priority?: 1 | 2 | 3;
}

const VIRTUALIZE_ABOVE = 100;
const OVERSCAN = 8;
const DEFAULT_ROW_H = 32;

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowOpen,
  selectedId,
  empty,
}: {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** A row opens on one click — everywhere, so no list ever waits for a double. */
  onRowOpen?: (row: T) => void;
  selectedId?: string;
  empty?: ReactNode;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  const [rowH, setRowH] = useState(DEFAULT_ROW_H);
  /** The table's own width, and the root size the rem column widths resolve against. */
  const [viewportW, setViewportW] = useState(0);
  const [rootPx, setRootPx] = useState(0);

  /*
   * Measure against the pane that actually scrolls.
   *
   * This used to read `wrapRef.current.clientHeight` and take `scrollTop` from
   * an `onScroll` on the wrapper — and the whole virtualiser was therefore
   * inert. `.ob-tablewrap` has `overflow: auto` but no height constraint, so
   * it grows to the full height of the table and never scrolls; the real
   * scroller is the enclosing `.ob-pane`. `clientHeight` was the entire table
   * height, `visibleCount` came out larger than `rows.length`, and React's
   * `onScroll` never fired because scroll does not bubble. Every row rendered,
   * always. That was survivable while one screen was mounted at a time; with
   * screens kept alive it would multiply a 500-row page by every tab visited.
   *
   * Row height is measured from a real row rather than read out of `--row-h`
   * with `getComputedStyle`. The token is about to become a rem value, and
   * `parseFloat('2.2857rem')` is 2.2857 — which would ask for roughly ten
   * thousand rows.
   */
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;

    const scroller = wrap.closest('.ob-pane') as HTMLElement | null;

    const measure = () => {
      const row = wrap.querySelector('tbody tr[data-row]') as HTMLElement | null;
      if (row && row.offsetHeight > 0) setRowH(row.offsetHeight);
      setViewportH(scroller ? scroller.clientHeight : wrap.clientHeight);
      setViewportW(wrap.clientWidth);
      setRootPx(parseFloat(getComputedStyle(document.documentElement).fontSize) || 0);
      setScrollTop(scroller ? Math.max(0, scroller.scrollTop - wrap.offsetTop) : 0);
    };

    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(wrap);
    if (scroller) observer.observe(scroller);

    // Passive: this only reads, and the listener sits on a scroller that also
    // carries the page's own scrolling.
    scroller?.addEventListener('scroll', measure, { passive: true });

    return () => {
      observer.disconnect();
      scroller?.removeEventListener('scroll', measure);
    };
  }, [rows.length]);

  const virtualize = rows.length > VIRTUALIZE_ABOVE;
  let visibleRows = rows;
  let padTop = 0;
  let padBottom = 0;

  if (virtualize) {
    const first = Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN);
    const visibleCount = Math.ceil(viewportH / rowH) + OVERSCAN * 2;
    const last = Math.min(rows.length, first + visibleCount);
    visibleRows = rows.slice(first, last);
    padTop = first * rowH;
    padBottom = (rows.length - last) * rowH;
  }

  /*
   * Which columns survive this width. Recomputed from the full set on every
   * measure — see `fitColumns.ts` for why that matters and why it is only safe
   * given the rule that a row opens its whole record in a modal.
   */
  const visible = fitColumns(columns, viewportW, rootPx);

  const gridTemplate = gridTemplateFor(visible);

  if (rows.length === 0) {
    return <div className="ob-tablewrap">{empty}</div>;
  }

  return (
    <div ref={wrapRef} className="ob-tablewrap">
      <table className="ob-table" style={{ tableLayout: 'fixed' }}>
        <colgroup>
          {visible.map((c) => (
            <col key={c.key} style={{ width: c.width }} />
          ))}
        </colgroup>
        <thead>
          <tr style={{ display: 'grid', gridTemplateColumns: gridTemplate }}>
            {visible.map((c) => (
              <th
                key={c.key}
                className={c.align === 'right' ? 'num' : undefined}
                style={{ display: 'flex', alignItems: 'center' }}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody style={{ display: 'block' }}>
          {padTop > 0 && (
            <tr style={{ height: padTop, display: 'block' }} aria-hidden="true">
              <td style={{ padding: 0, border: 'none' }} />
            </tr>
          )}
          {visibleRows.map((row) => {
            const key = rowKey(row);
            return (
              <tr
                key={key}
                // Marks a real data row, so the virtualiser can measure one
                // rather than trusting a CSS token it would have to parse.
                data-row=""
                data-selected={selectedId === key || undefined}
                style={{
                  display: 'grid',
                  gridTemplateColumns: gridTemplate,
                  cursor: onRowOpen ? 'pointer' : undefined,
                }}
                tabIndex={onRowOpen ? 0 : undefined}
                role={onRowOpen ? 'button' : undefined}
                onClick={onRowOpen ? () => onRowOpen(row) : undefined}
                onKeyDown={
                  onRowOpen
                    ? (e) => {
                        if (e.key === 'Enter') onRowOpen(row);
                      }
                    : undefined
                }
              >
                {visible.map((c) => {
                  const reason = c.redactedReason?.(row);
                  return (
                    <td
                      key={c.key}
                      className={c.align === 'right' ? 'num' : undefined}
                      style={{ display: 'flex', alignItems: 'center' }}
                    >
                      {reason ? (
                        <span
                          className="ob-redacted"
                          title={`Missing permission: ${reason}`}
                          aria-label="Hidden"
                        />
                      ) : (
                        c.render(row)
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
          {padBottom > 0 && (
            <tr style={{ height: padBottom, display: 'block' }} aria-hidden="true">
              <td style={{ padding: 0, border: 'none' }} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
