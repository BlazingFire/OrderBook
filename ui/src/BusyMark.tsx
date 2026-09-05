/**
 * The busy indicator (§6): the same mark, inking in reading order on a 780ms
 * loop at 42% opacity, eased with the standard curve. One asset, two jobs —
 * there is no other spinner in the product. Stops when the window loses focus
 * (see base.css) and collapses to a static grid under the motion kill switches.
 */

import { CELLS } from './logoCells';

export function BusyMark({
  size = 24,
  label = 'Working',
}: {
  size?: number;
  /** Announced to screen readers; pass '' inside labelled buttons. */
  label?: string;
}) {
  return (
    <svg
      className="ob-busy"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role={label ? 'status' : undefined}
      aria-label={label || undefined}
      style={{ flex: 'none' }}
    >
      {CELLS.map(([x, y], i) => (
        <rect
          key={i}
          x={x}
          y={y}
          width={4}
          height={4}
          rx={0.75}
          fill={size <= 16 ? 'currentColor' : 'var(--accent)'}
          /* Base opacity is the resting state when animation is disabled;
           * the keyframes drive it while looping. The stagger is 42ms, the
           * same as the splash's ink-in, so the two jobs read as one asset. */
          style={{ opacity: 0.25, animationDelay: `${i * 42}ms` }}
        />
      ))}
    </svg>
  );
}
