/**
 * RFC 6901 JSON pointers, which is how a field map names a remote field.
 *
 * A pointer rather than a dotted path or an expression, for one reason: it is a
 * closed, standard notation with no evaluation in it. A mapping is data a
 * shopkeeper fills in through a form; anything that could *execute* would make
 * that form a code path with the connector's authority behind it.
 *
 * Two escapes, and they are the whole specification: `~1` is a literal `/`, and
 * `~0` is a literal `~`. Order matters when unescaping — `~0` last, or `~01`
 * would decode to `/`.
 */

/** The value at a pointer, or `undefined` if the path does not resolve. */
export function readPointer(document: unknown, pointer: string): unknown {
  // The empty pointer is the whole document, which is what an `items_pointer`
  // of `''` means for an API that returns a bare array.
  if (pointer === '') return document;
  if (!pointer.startsWith('/')) return undefined;

  let current: unknown = document;

  for (const raw of pointer.slice(1).split('/')) {
    const token = raw.replace(/~1/g, '/').replace(/~0/g, '~');

    if (Array.isArray(current)) {
      const index = Number(token);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
      continue;
    }

    if (typeof current !== 'object' || current === null) return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, token)) return undefined;
    current = (current as Record<string, unknown>)[token];
  }

  return current;
}

/** The pointer form of one path token. */
function escape(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * Every pointer in a document, so the mapping picker can offer a list rather
 * than asking somebody to type one.
 *
 * Arrays are walked at index zero only. A remote list of two hundred line items
 * would otherwise produce two hundred near-identical pointers, and the shape is
 * what the picker is showing — `/lines/0/sku` is the answer somebody needs, and
 * it is the same answer for every index.
 */
export function flattenPointers(document: unknown, prefix = '', depth = 0): string[] {
  // A guard rather than a limit anybody will meet: a self-referencing structure
  // cannot arrive over JSON, but a deeply nested one can, and this is a picker.
  if (depth > 8) return [];

  if (Array.isArray(document)) {
    return document.length > 0 ? flattenPointers(document[0], `${prefix}/0`, depth + 1) : [];
  }

  if (typeof document === 'object' && document !== null) {
    return Object.entries(document).flatMap(([key, value]) =>
      flattenPointers(value, `${prefix}/${escape(key)}`, depth + 1),
    );
  }

  // A leaf. The prefix is the pointer that reaches it.
  return prefix ? [prefix] : [];
}
