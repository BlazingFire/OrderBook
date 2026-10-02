/**
 * One figure on a dashboard: an eyebrow label, a big number and a note.
 *
 * Lifted from the copies each panel's Dashboard kept to itself, so both read
 * the same. Counts only: this software carries no money anywhere.
 */

import type { ReactNode } from 'react';
import { Card } from './Card';
import { Icon, type IconName } from './icons';
import { Skeleton } from './States';

export function StatTile({
  label,
  value,
  note,
  tone,
  icon,
  onClick,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  /** Colours the figure: a conflict to review, something offline, all clear. */
  tone?: 'conflict' | 'offline' | 'ok';
  icon?: IconName;
  /** Makes the whole tile a button, usually to the screen behind the figure. */
  onClick?: () => void;
}) {
  const body = (
    <>
      <span className="ob-stattile-head">
        {icon && <Icon name={icon} size={14} />}
        <span className="ob-eyebrow">{label}</span>
      </span>
      <span className="ob-stattile-value ob-display">{value}</span>
      {note && <span className="ob-stattile-note ob-small">{note}</span>}
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        className="ob-card ob-card--pad ob-stattile"
        data-tone={tone}
        onClick={onClick}
      >
        {body}
      </button>
    );
  }

  return (
    <div className="ob-card ob-card--pad ob-stattile" data-tone={tone}>
      {body}
    </div>
  );
}

/** The tile's shape while its figure loads. Static, like every skeleton. */
export function StatTileSkeleton() {
  return (
    <Card>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-8)' }}>
        <Skeleton width="60%" height="var(--t-eyebrow-line)" />
        <Skeleton width="40%" height="var(--t-display-line)" />
        <Skeleton width="80%" height="var(--t-small-line)" />
      </div>
    </Card>
  );
}
