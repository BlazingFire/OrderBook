/** FilterBar (§8) — the 40px strip under the topbar on list screens only. */

import type { ReactNode } from 'react';

export function FilterBar({ children }: { children: ReactNode }) {
  return <div className="ob-filterbar">{children}</div>;
}

export function FilterChip({
  active,
  count,
  onClick,
  children,
}: {
  active?: boolean;
  count?: number;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" className="ob-filterchip" aria-pressed={active} onClick={onClick}>
      {children}
      {count != null && <span className="count">{count}</span>}
    </button>
  );
}

export function FilterDivider() {
  return <span className="ob-divider" />;
}
