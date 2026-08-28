/** Card and Section (§9 Structure) — elevation level 1: a hairline, never a shadow. */

import type { HTMLAttributes, ReactNode } from 'react';

export function Card({
  padded = true,
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { padded?: boolean }) {
  const classes = ['ob-card', padded ? 'ob-card--pad' : '', className].filter(Boolean).join(' ');
  return (
    <div className={classes} {...rest}>
      {children}
    </div>
  );
}

export function Section({
  title,
  action,
  children,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-8)' }}>
      {(title || action) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-12)' }}>
          {title && (
            <h2 className="ob-title" style={{ margin: 0, flex: 1 }}>
              {title}
            </h2>
          )}
          {action}
        </div>
      )}
      {children}
    </div>
  );
}
