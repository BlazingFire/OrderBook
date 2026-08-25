/**
 * The mark — "The Fill" (§6). A 4×3 lattice of 4px squares inside a 24px box,
 * 2px gutters: bottom row inked, middle row inked, top row two of four.
 * Reads three ways at once: a stock grid, colour swatches, a ledger filling up.
 * ~600 bytes of inline SVG — no icon font, no image file.
 */

import { CELLS } from './logoCells';

export function Logo({
  size = 24,
  color = 'var(--accent)',
}: {
  size?: number;
  color?: string;
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {CELLS.map(([x, y], i) => (
        <rect key={i} x={x} y={y} width={4} height={4} fill={color} />
      ))}
    </svg>
  );
}

/** Mark + wordmark lockup; mark sits 8px left of the wordmark (§6). */
export function LogoLockup({ markSize = 24 }: { markSize?: number }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-8)' }}>
      <Logo size={markSize} />
      <span className="ob-sidebar-wordmark">OrderBook</span>
    </span>
  );
}
