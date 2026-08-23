/**
 * The identity of a stock row.
 *
 * Stock is keyed by a **pair** — (product, colour) — not by an id of its own,
 * so several places need to index maps by that pair. Doing it with an inline
 * template literal invites exactly one bug: two call sites that look identical
 * but separate the halves differently, producing keys that never match and a
 * reservation total that silently reads as zero. One function removes the
 * possibility.
 *
 * The separator is written as an escape rather than as a literal control
 * character, so it survives copy-paste and is visible in review. ASCII Unit
 * Separator cannot appear in a product id or in a colour someone typed, so no
 * colour can forge a collision with a different product.
 */

const SEPARATOR = '\u001f';

export function stockKey(productId: string, colour: string): string {
  return `${productId}${SEPARATOR}${colour}`;
}

export function parseStockKey(key: string): { productId: string; colour: string } {
  const index = key.indexOf(SEPARATOR);
  if (index === -1) return { productId: key, colour: '' };

  return { productId: key.slice(0, index), colour: key.slice(index + 1) };
}
