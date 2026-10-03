/**
 * Exactly one note on the paper (docs/ORDER_NOTES_PLAN.md).
 *
 * Every `OrderNoteScreen` mounts its note in a portal on `<body>`, and the print
 * stylesheet shows each `.ob-note-print-portal`. `ScreenHost` keeps hidden
 * screens mounted, so a second note screen (or a station's job) would print
 * under the visible one. `printOnly` marks the one portal that is meant for the
 * paper for as long as the job runs; `order-note.css` hides every other. Every
 * print and Save PDF goes through it.
 */

const ACTIVE = 'ob-note-print-portal--active';
const PRINTING = 'ob-printing';

/**
 * Runs `run` (the print or the PDF save) with only `portal` visible to the
 * printer, and puts the page back whatever `run` does. With no portal there is
 * nothing to isolate and `run` is called as it is.
 */
export async function printOnly<T>(portal: HTMLElement | null, run: () => Promise<T> | T): Promise<T> {
  if (!portal) return run();
  portal.classList.add(ACTIVE);
  document.body.classList.add(PRINTING);
  try {
    return await run();
  } finally {
    document.body.classList.remove(PRINTING);
    portal.classList.remove(ACTIVE);
  }
}
