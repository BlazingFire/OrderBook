/**
 * The busy indicator, per the Feedback artboard: the mark's ten cells at 40 % opacity,
 * each lighting from 0.15 to full and back in reading order, 70 ms apart, on a 700 ms
 * linear loop. One asset, two jobs: there is no other spinner in the product. Stops when
 * the window loses focus (see base.css) and holds still, every cell lit, under reduced
 * motion or the app's motion switch.
 */

import { t } from './i18n.js';
import { CELLS } from './logoCells';

export function BusyMark({
  size = 24,
  label = t('common.working'),
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
          rx={0.6}
          fill="var(--accent)"
          style={{ animationDelay: `${i * 70}ms` }}
        />
      ))}
    </svg>
  );
}
