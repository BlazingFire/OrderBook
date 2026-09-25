/**
 * The three widths at which the layout reorganises.
 *
 * **Physical CSS pixels, deliberately — not rem.** Two reasons, and both are
 * load-bearing:
 *
 *  1. A layout that reorganised while you dragged the scale slider would read
 *     as a bug. Scale changes how big things are; it must not change what is
 *     on screen.
 *  2. `em` inside `@media` resolves against the *browser default* (16px), not
 *     `html { font-size }`, so a media query cannot track `--root-size` even
 *     if we wanted it to. A JS threshold could, which is exactly why it must
 *     not be used here.
 *
 * There is deliberately **no upper breakpoint and no shell max-width**. On a
 * 4K screen the app should show more, not the same thing enlarged: the
 * DataTable's trailing filler track absorbs slack, the `auto-fit` grids gain
 * columns, and only surfaces bound by reading measure (modals, forms) cap. The
 * OS display-scaling setting already made the "make everything bigger" choice,
 * and the scale slider is the operator's override of it.
 */

/** Sidebar auto-collapses, detail grids go single column, low-priority columns drop. */
export const BP_NARROW = '(max-width: 1180px)';
