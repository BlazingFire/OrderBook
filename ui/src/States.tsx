/**
 * Feedback surfaces (§9.4): two lines and one action, never an illustration.
 * Errors do not apologise and name what failed; permission failures name the
 * permission. Skeleton rows are static — the busy mark is the product's only
 * mover.
 */

import type { ReactNode } from 'react';
import { Button } from './Button';

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
  actionLabel = 'Retry now',
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
