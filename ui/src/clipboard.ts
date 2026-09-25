/**
 * Put text on the clipboard — over plain HTTP too.
 *
 * `navigator.clipboard` exists only in a secure context. The desktop shell
 * loads `http://localhost`, which is one, but the Master binds `0.0.0.0` and is
 * opened by LAN address from other machines' browsers, where it is not — there
 * `navigator.clipboard` is `undefined`, and a Copy button that called it
 * directly threw before copying anything.
 *
 * So the clipboard API when the browser offers it and allows the write, and
 * otherwise the route that predates it: a selected, off-screen textarea and
 * `document.execCommand('copy')`. Deprecated, but it is what every browser
 * still honours from a click, in any context.
 *
 * Resolves to whether the text was copied, rather than throwing, so a button
 * can say "Copied" only when it was.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Refused — the document lost focus, or a permissions policy says no.
    // The legacy route below may still be allowed.
  }
  return copyWithSelection(text);
}

function copyWithSelection(text: string): boolean {
  if (typeof document.execCommand !== 'function') return false;

  const area = document.createElement('textarea');
  area.value = text;
  area.readOnly = true;
  // Fixed and transparent rather than `display: none`: a hidden element cannot
  // hold a selection, and a positioned one would scroll the page to itself.
  area.style.position = 'fixed';
  area.style.top = '0';
  area.style.left = '0';
  area.style.opacity = '0';
  area.style.pointerEvents = 'none';

  // The Copy button, usually — handed focus back so the keyboard stays put.
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.body.appendChild(area);
  area.focus({ preventScroll: true });
  area.select();

  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  } finally {
    area.remove();
    previous?.focus({ preventScroll: true });
  }
  return copied;
}
