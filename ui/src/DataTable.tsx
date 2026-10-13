/**
 * DataTable (§9.1) — the workhorse. Cursor pagination only, virtualized above
 * 100 rows (non-negotiable on 4GB machines, §11). Redacted fields render an
 * em dash with a tooltip naming the missing permission, and must cope with an
 * absent key (redaction removes the key — never assume `null`).
 */

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { IconButton } from './Button.js';
import { fitColumns, gridTemplateFor } from './fitColumns.js';
import { t } from './i18n.js';

/** The key of the tick-box column a table adds when it is given `onSelectionChange`. */
const SELECT_KEY = '__select';

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
  /**
   * What this column sorts by. Present makes the header a sort control.
   *
   * A value function rather than a flag, because `render` returns a
   * `ReactNode` — a pill, a two-line summary, a colour chip — and there is no
   * general way to order those. The column says what its own underlying value
   * is; `null`/`undefined` sorts last in both directions, so a row missing the
   * value never displaces one that has it.
   */
  sortValue?: (row: T) => string | number | null | undefined;
  /**
   * 1.4 D3: a column the server sorts. Makes the header a sort control without a
   * `sortValue`; pair it with `sortLocally={false}` so the rows are shown as the
   * server ordered them.
   */
  sortable?: boolean;
}

export interface DataTableSort {
  key: string;
  dir: 'asc' | 'desc';
}

/** `null`/`undefined` last in both directions; strings compared case-insensitively. */
function compareValues(
  a: string | number | null | undefined,
  b: string | number | null | undefined,
): number {
  const aMissing = a === null || a === undefined || a === '';
  const bMissing = b === null || b === undefined || b === '';
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;

  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

const EMPTY_SELECTION: ReadonlySet<string> = new Set();

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
  sort,
  onSortChange,
  sortLocally = true,
  selectedIds,
  onSelectionChange,
  rowHighlight,
}: {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** A row opens on one click — everywhere, so no list ever waits for a double. */
  onRowOpen?: (row: T) => void;
  selectedId?: string;
  empty?: ReactNode;
  /**
   * Controlled, so a screen that pages from the server can sort there instead
   * and still render the header state. Omit `onSortChange` and the headers stay
   * inert even on a column that declares a `sortValue`.
   */
  sort?: DataTableSort;
  onSortChange?: (sort: DataTableSort) => void;
  /**
   * False when the server already returned the rows in `sort` order (a paged
   * list): the header still shows the state and still sorts on click, but the
   * rows are shown as given, so a later page does not reshuffle an earlier one.
   */
  sortLocally?: boolean;
  /**
   * 1.4 D3: tick boxes. Give `onSelectionChange` and the table adds a first
   * column with one per row and a select-all in the header (the rows it holds).
   * A tick does not open the row. `selectedIds` is the caller's state.
   */
  selectedIds?: ReadonlySet<string>;
  onSelectionChange?: (ids: Set<string>) => void;
  /** Rows this returns true for carry `data-highlight` (a Server Master's rows, today). */
  rowHighlight?: (row: T) => boolean;
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
   * inert. `.ob-tablewrap` clips (`overflow: clip`) and has no height constraint, so
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

  /*
   * Sorted before the virtualisation slice, which already operates on a plain
   * array — so this is additive rather than a restructure. A copy, because
   * `rows` belongs to the caller and `sort` in place would reorder their state.
   */
  const sorted = useMemo(() => {
    if (!sort || !sortLocally) return rows;
    const column = columns.find((c) => c.key === sort.key);
    if (!column?.sortValue) return rows;

    const direction = sort.dir === 'asc' ? 1 : -1;
    const value = column.sortValue;
    return [...rows].sort((a, b) => compareValues(value(a), value(b)) * direction);
  }, [rows, columns, sort, sortLocally]);

  const virtualize = sorted.length > VIRTUALIZE_ABOVE;
  let visibleRows = sorted;
  let padTop = 0;
  let padBottom = 0;

  if (virtualize) {
    const first = Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN);
    const visibleCount = Math.ceil(viewportH / rowH) + OVERSCAN * 2;
    const last = Math.min(sorted.length, first + visibleCount);
    visibleRows = sorted.slice(first, last);
    padTop = first * rowH;
    padBottom = (sorted.length - last) * rowH;
  }

  /*
   * Which columns survive this width. Recomputed from the full set on every
   * measure — see `fitColumns.ts` for why that matters and why it is only safe
   * given the rule that a row opens its whole record in a modal.
   */
  const allColumns = useMemo<DataTableColumn<T>[]>(
    () =>
      onSelectionChange
        ? [
            {
              key: SELECT_KEY,
              header: t('table.selectAll'),
              // The 1.5rem box plus the first column's padding (--s-16 left, --s-12 right);
              // a bare 2.5rem squeezed the box and clipped its right edge.
              width: '3.5rem',
              render: () => null,
            },
            ...columns,
          ]
        : columns,
    [columns, onSelectionChange],
  );
  const visible = fitColumns(allColumns, viewportW, rootPx);
  const chosen = selectedIds ?? EMPTY_SELECTION;
  const shownKeys = sorted.map(rowKey);
  const allChosen = shownKeys.length > 0 && shownKeys.every((key) => chosen.has(key));
  const someChosen = shownKeys.some((key) => chosen.has(key));
  const toggleAll = (): void =>
    onSelectionChange?.(allChosen ? new Set() : new Set([...chosen, ...shownKeys]));
  const toggleOne = (key: string): void => {
    const next = new Set(chosen);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onSelectionChange?.(next);
  };

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
            {visible.map((c) => {
              if (c.key === SELECT_KEY) {
                return (
                  <th key={c.key} style={{ display: 'flex', alignItems: 'center' }}>
                    <input
                      type="checkbox"
                      aria-label={t('table.selectAll')}
                      checked={allChosen}
                      ref={(el) => {
                        if (el) el.indeterminate = someChosen && !allChosen;
                      }}
                      onChange={toggleAll}
                    />
                  </th>
                );
              }
              const sortable = Boolean((c.sortValue || c.sortable) && onSortChange);
              const active = sort?.key === c.key ? sort.dir : undefined;

              return (
                <th
                  key={c.key}
                  className={c.align === 'right' ? 'num' : undefined}
                  // `aria-sort` belongs on the header cell, not on the button
                  // inside it — a screen reader announces the column's state,
                  // not the control's.
                  aria-sort={
                    sortable
                      ? active === 'asc'
                        ? 'ascending'
                        : active === 'desc'
                          ? 'descending'
                          : 'none'
                      : undefined
                  }
                  style={{ display: 'flex', alignItems: 'center' }}
                >
                  {sortable ? (
                    <button
                      type="button"
                      className="ob-th-sort"
                      title={t('table.sortBy', { column: c.header })}
                      onClick={() =>
                        onSortChange?.({
                          key: c.key,
                          // First click sorts ascending; clicking the active
                          // column flips it.
                          dir: active === 'asc' ? 'desc' : 'asc',
                        })
                      }
                    >
                      {c.header}
                      <span aria-hidden="true" className="ob-th-caret">
                        {active === 'asc' ? '▲' : active === 'desc' ? '▼' : '↕'}
                      </span>
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
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
                // A row says whether it is selected when the table has any idea of
                // selection (the open record, or ticked rows); `row` is explicit because
                // a grid-laid-out `tr` is not reliably a row to assistive tech, and
                // `aria-selected` is not allowed on the `button` role the row used to carry.
                role="row"
                aria-selected={
                  selectedId !== undefined || onSelectionChange
                    ? selectedId === key || chosen.has(key)
                    : undefined
                }
                data-highlight={rowHighlight?.(row) || undefined}
                style={{
                  display: 'grid',
                  gridTemplateColumns: gridTemplate,
                  cursor: onRowOpen ? 'pointer' : undefined,
                }}
                tabIndex={onRowOpen ? 0 : undefined}
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
                  if (c.key === SELECT_KEY) {
                    return (
                      <td
                        key={c.key}
                        style={{ display: 'flex', alignItems: 'center' }}
                        // A tick is not a request to open the row.
                        onClick={(event) => event.stopPropagation()}
                        onKeyDown={(event) => event.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          aria-label={t('table.selectRow')}
                          checked={chosen.has(key)}
                          onChange={() => toggleOne(key)}
                        />
                      </td>
                    );
                  }
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
                          title={t('error.forbidden.missingPermission', { permission: reason })}
                          aria-label={t('table.redacted')}
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

/**
 * A row's Edit and Delete as icons, in the list's Action column. Absent, not
 * greyed, when the handler is missing. A click here must not also open the
 * record the row stands for, so the click and the key stop at the cell.
 */
export function RowActions({
  onEdit,
  onDelete,
  editLabel,
  deleteLabel,
}: {
  onEdit?: () => void;
  onDelete?: () => void;
  editLabel: string;
  deleteLabel: string;
}) {
  if (!onEdit && !onDelete) return null;
  return (
    <span
      className="ob-rowactions"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {onEdit && <IconButton icon="edit" label={editLabel} className="ob-rowactions-edit" onClick={onEdit} />}
      {onDelete && <IconButton icon="trash" label={deleteLabel} variant="danger" onClick={onDelete} />}
    </span>
  );
}
