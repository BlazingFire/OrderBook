/**
 * The busy indicator (the Motion artboard): the mark's ten squares pulsing in
 * reading order on a 700 ms loop, 70 ms apart, the whole mark at 40 %. The only
 * loading indicator in the product. It pauses when the window loses focus, and
 * under reduced motion or the motion switch it stands still as the full mark
 * (`mark.css`).
 */

import { t } from './i18n.js';
import { CELLS, CELL_RADIUS } from './logoCells.js';

/** Delay between one square's pulse and the next. */
export const BUSY_STAGGER_MS = 70;

export function BusyMark({
  size = 24,
  label = t('common.working'),
}: {
  size?: number;
  /** Announced to screen readers; pass '' inside labelled buttons. */
  label?: string;
}) {
  // At 16 px and below the mark is inline (the Buttons artboard's loading
  // buttons): square corners, the text colour, full strength resting at 25 %
  // instead of the whole mark dimmed to 40 %, so it reads in a primary button.
  const small = size <= 16;
  return (
    <svg
      className={small ? 'ob-busy ob-busy--inline' : 'ob-busy'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role={label ? 'status' : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : true}
      style={{ flex: 'none' }}
    >
      <g fill={small ? 'currentColor' : 'var(--ob-mark-ink)'}>
        {CELLS.map(([x, y], i) => (
          <rect
            key={i}
            x={x}
            y={y}
            width={4}
            height={4}
            rx={small ? 0 : CELL_RADIUS}
            style={{ animationDelay: `${i * BUSY_STAGGER_MS}ms` }}
          />
        ))}
      </g>
    </svg>
  );
}
