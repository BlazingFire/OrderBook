/** FilterBar pieces (§8) — the chips and dividers a list screen publishes into the strip under the topbar. */

import type { ReactNode } from 'react';

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
