/**
 * Feedback surfaces (§9.4): two lines and one action, never an illustration.
 * Errors do not apologise and name what failed; permission failures name the
 * permission. Skeleton rows are static — the busy mark is the product's only
 * mover.
 */

import type { ReactNode } from 'react';
import { Button } from './Button';
import type { DataTableColumn } from './DataTable';
import { fitColumns, gridTemplateFor } from './fitColumns';
import { t } from './i18n.js';

export function EmptyState({
  title,
  description,
  actionLabel,
  onAction,
}: {
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="ob-empty">
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {actionLabel && onAction && (
        <Button variant="primary" onClick={onAction}>
          {actionLabel}
        </Button>
      )}
    </div>
  );
}

export function ErrorState({
  title,
  description,
  actionLabel = t('action.retryNow'),
  onAction,
}: {
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="ob-empty">
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {onAction && (
        <Button variant="secondary" onClick={onAction}>
          {actionLabel}
        </Button>
      )}
    </div>
  );
}

export function ConflictBanner({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="ob-banner ob-banner--conflict" role="alert">
      <span style={{ flex: 1 }}>{children}</span>
      {action}
    </div>
  );
}

export function OfflineBanner({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="ob-banner ob-banner--offline" role="status">
      <span style={{ flex: 1 }}>{children}</span>
      {action}
    </div>
  );
}

export function Skeleton({
  width = '100%',
  height = 'var(--s-8)',
}: {
  width?: string | number;
  height?: string | number;
}) {
  return <div className="ob-skeleton" style={{ width, height }} aria-hidden="true" />;
}

export function SkeletonRows({ rows = 6, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--s-12)',
        padding: 'var(--s-16)',
      }}
    >
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} style={{ display: 'flex', gap: 'var(--s-16)' }}>
          {Array.from({ length: columns }).map((_, c) => (
            <Skeleton key={c} width={c === 0 ? '20%' : `${100 / columns}%`} />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * A skeleton shaped like the table that is about to arrive.
 *
 * Added **alongside** `SkeletonRows`, not as a replacement: eleven call sites
 * are not table-shaped and a generic block of bars is right for those.
 *
 * The point of a separate component is that nothing shifts on arrival. It
 * builds its grid template exactly the way `DataTable` does — the same column
 * widths, the same trailing filler track when every column is fixed — so the
 * real rows land on the lines the placeholder already drew. A skeleton whose
 * columns are in different places than the data is worse than no skeleton: it
 * animates the layout at the moment the reader starts reading.
 *
 * The rendering contract this belongs to: **first load shows a skeleton, never
 * an `EmptyState`.** "Nobody here yet" on a screen that is still fetching is a
 * statement about the company that happens to be false.
 */
export function SkeletonTable<T>({
  columns,
  rows = 8,
}: {
  columns: DataTableColumn<T>[];
  rows?: number;
}) {
  // Zero width means "not measured", and `fitColumns` answers with everything —
  // which is what a placeholder wants: the same columns the first real render
  // will show before it has measured either.
  const visible = fitColumns(columns, 0, 0);
  const gridTemplate = gridTemplateFor(visible);

  return (
    <div className="ob-tablewrap" aria-hidden="true">
      <table className="ob-table" style={{ tableLayout: 'fixed' }}>
        <thead>
          <tr style={{ display: 'grid', gridTemplateColumns: gridTemplate }}>
            {visible.map((column) => (
              <th key={column.key} style={{ display: 'flex', alignItems: 'center' }}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody style={{ display: 'block' }}>
          {Array.from({ length: rows }).map((_, row) => (
            <tr key={row} style={{ display: 'grid', gridTemplateColumns: gridTemplate }}>
              {visible.map((column) => (
                <td key={column.key} style={{ display: 'flex', alignItems: 'center' }}>
                  <Skeleton width={column.align === 'right' ? '40%' : '70%'} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
