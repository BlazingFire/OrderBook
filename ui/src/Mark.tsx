/**
 * The mark, "The Fill": one 24 × 24 inline SVG, about 600 bytes, no icon font
 * and no image file (the Mark, Marks, Icons and Usage artboards).
 *
 * The ink and the ghost opacity default to `--ob-mark-ink` and
 * `--ob-mark-ghost` (`mark.css`): cobalt at 0.2 in light, the lighter blue at
 * 0.28 in dark. A one-colour mark for print is `ghost={0}`. At 24 px and below
 * the ghost squares are left out altogether, not merely faint, so a small mark
 * is ten crisp squares.
 *
 * Never recolour the squares with product colours: in this product colour is data.
 */

import { CELLS, CELL_RADIUS, GHOST_CELLS, GHOSTLESS_MAX_PX } from './logoCells.js';

export interface MarkProps {
  /** Rendered size in px. */
  size?: number;
  /** Any CSS colour; defaults to the theme's mark ink. */
  ink?: string;
  /** Opacity of the two ghost squares, 0 to 1; defaults to the theme's. Ignored at 24 px and below. */
  ghost?: number;
  /** Announced to screen readers; without it the mark is decoration and hidden from them. */
  title?: string;
}

/** Whether a mark drawn at `size` px shows its ghost squares. */
export function markShowsGhosts(size: number): boolean {
  return size > GHOSTLESS_MAX_PX;
}

export function Mark({ size = 24, ink = 'var(--ob-mark-ink)', ghost, title }: MarkProps) {
  return (
    <svg
      className="ob-mark"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      {...(title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true })}
      style={{ flex: 'none' }}
    >
      <g fill={ink}>
        {CELLS.map(([x, y]) => (
          <rect key={`${x}:${y}`} x={x} y={y} width={4} height={4} rx={CELL_RADIUS} />
        ))}
      </g>
      {markShowsGhosts(size) && (
        // The theme's ghost opacity comes from `mark.css`; a given one overrides it.
        <g fill={ink} data-ghost="" style={ghost === undefined ? undefined : { opacity: ghost }}>
          {GHOST_CELLS.map(([x, y]) => (
            <rect key={`${x}:${y}`} x={x} y={y} width={4} height={4} rx={CELL_RADIUS} />
          ))}
        </g>
      )}
    </svg>
  );
}
