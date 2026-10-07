/**
 * The lattice geometry of "The Fill" (the Mark artboard), shared by the mark,
 * the splash sequence, the busy indicator and the app icons
 * (`tools/make-icons.mjs` reads this file) — one asset, four jobs.
 *
 * A 4 × 3 lattice of 4-unit squares with 2-unit gutters in a 24-unit box: the
 * middle and bottom rows inked, the top row two of four, and the other two top
 * squares drawn as "ghosts" at a low opacity.
 */

/** The ten inked squares, in reading order (the order the splash and the busy loop ink them). */
export const CELLS: ReadonlyArray<readonly [number, number]> = [
  [1, 4],
  [7, 4],
  [1, 10],
  [7, 10],
  [13, 10],
  [19, 10],
  [1, 16],
  [7, 16],
  [13, 16],
  [19, 16],
];

/** The two top-right squares: drawn faint above 24 px, left out at 24 px and below. */
export const GHOST_CELLS: ReadonlyArray<readonly [number, number]> = [
  [13, 4],
  [19, 4],
];

/** Corner radius of every square, in the 24-unit box. */
export const CELL_RADIUS = 0.6;

/** The largest size, in px, that leaves the ghost squares out so the mark stays crisp. */
export const GHOSTLESS_MAX_PX = 24;
