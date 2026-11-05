/**
 * Which of a table's columns actually fit, and which get dropped on a narrow
 * screen.
 *
 * **This is only safe because of a standing rule in this product: an Open on a
 * table row shows the whole record on a screen of its own** (pinned in
 * `master/tests/ui-conventions.test.ts`). A dropped column is therefore never
 * the only way to see a value — it is one click away. A table
 * with no `onRowOpen` must leave every column at priority 1, because for that
 * table the row *is* the record and dropping a column hides data with no path
 * back to it.
 *
 * Deliberately DOM-free so it can be unit-tested without jsdom: it takes the
 * available width and the root font size as numbers, and returns a subset of
 * the array it was handed.
 *
 * It always recomputes from the **full** column set rather than from whatever
 * survived last time. Narrowing a window would otherwise drop a column,
 * widening it would not bring the column back, and a re-measure after the drop
 * could drop another — the classic oscillation.
 */

/** The shape `fitColumns` needs. `DataTableColumn<T>` satisfies it. */
export interface FittableColumn {
  key: string;
  /** A CSS track: `'12rem'`, `'160px'`, `'1fr'`, `'auto'`, or absent. */
  width?: string;
  /**
   * How willingly this column is dropped when the table runs out of room.
   * `1` (or absent) never drops. `3` goes first, then `2`.
   */
  priority?: 1 | 2 | 3;
}

/**
 * What a flexible or unspecified column is assumed to need.
 *
 * A `1fr` track has no intrinsic width, so nothing can be summed from it. This
 * is the width below which such a column stops being readable — roughly a
 * date, a short name, or a status pill — and it is the same constant the
 * narrow-screen work uses for `.ob-detail-grid`'s single-column threshold.
 *
 * In rem, not px: 120 px at the default 14 px root. A fixed 120 px went on
 * claiming a column fitted at 157 %, where the same text needs half as much
 * again, so no column was ever dropped and every one was cut instead.
 */
const FLEXIBLE_COLUMN_REM = 120 / 14;

/** `'12rem'` / `'160px'` / `'1fr'` → a number of physical pixels. */
export function columnWidthPx(width: string | undefined, rootPx: number): number {
  if (!width) return FLEXIBLE_COLUMN_REM * rootPx;

  const trimmed = width.trim();

  const rem = /^(-?[\d.]+)rem$/.exec(trimmed);
  if (rem) return Number(rem[1]) * rootPx;

  const px = /^(-?[\d.]+)px$/.exec(trimmed);
  if (px) return Number(px[1]);

  // `fr`, `%`, `auto`, `minmax(...)`, anything else: no intrinsic width.
  return FLEXIBLE_COLUMN_REM * rootPx;
}

/**
 * The columns to render, given the width the table has to render them in.
 *
 * Returns the input array untouched when `availableWidth` is not a usable
 * measurement — a table that has not been measured yet must show everything,
 * never a narrow-screen subset that then widens on the second frame.
 */
export function fitColumns<T extends FittableColumn>(
  columns: T[],
  availableWidth: number,
  rootPx: number,
): T[] {
  if (!(availableWidth > 0) || !(rootPx > 0)) return columns;

  const needed = (subset: T[]): number =>
    subset.reduce((total, column) => total + columnWidthPx(column.width, rootPx), 0);

  if (needed(columns) <= availableWidth) return columns;

  const withoutThree = columns.filter((column) => column.priority !== 3);
  if (needed(withoutThree) <= availableWidth) return withoutThree;

  // Priority 1 (and an absent priority, which means the same) never drops. If
  // the table still does not fit, `.ob-tablewrap` clips what overflows (it is
  // `overflow: clip`, which never scrolls): a priority-1 column that cannot fit is
  // cut at the table's edge rather than making the body scroll sideways.
  return withoutThree.filter((column) => column.priority !== 2);
}

/**
 * The CSS grid template a set of columns renders as.
 *
 * Shared by `DataTable` and `SkeletonTable` so the placeholder draws its
 * columns on exactly the lines the real rows will land on — a skeleton whose
 * columns sit elsewhere animates the layout at the moment somebody starts
 * reading it.
 *
 * A table whose columns are all fixed widths sums to less than a wide screen
 * gives it, and the leftover would sit past the last column as bare canvas —
 * row stripes and the header band stopping mid-table, which reads as a
 * rendering fault. One flexible filler track absorbs the slack into an empty
 * trailing cell instead. A table that already has a flexible column needs no
 * filler: that column is what the slack is for, and a second `1fr` would halve
 * it.
 */
export function gridTemplateFor(columns: readonly FittableColumn[]): string {
  const tracks = columns.map((column) => column.width ?? '1fr');
  return [...tracks, ...(needsFiller(columns) ? ['minmax(0, 1fr)'] : [])].join(' ');
}

/**
 * True when `gridTemplateFor` adds a trailing filler track. The table renders an empty cell in it, so
 * a row's stripe, hairline and hover/selected tint run to the table's right edge, not only to its last column.
 */
export function needsFiller(columns: readonly FittableColumn[]): boolean {
  return !columns.some((column) => /(\bauto\b|fr|%)/.test(column.width ?? '1fr'));
}
