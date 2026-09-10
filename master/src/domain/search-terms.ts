/**
 * Turning what somebody typed into something Postgres will accept.
 *
 * Pure, so the escaping can be tested without a database — which matters,
 * because both functions below are about characters that are ordinary in this
 * product's data and special in SQL.
 */

/**
 * A prefix `tsquery`: `gla ser` becomes `gla:* & ser:*`.
 *
 * `websearch_to_tsquery` is right for a search *box* — it understands quoted
 * phrases and never throws on punctuation — but it matches whole lexemes, so
 * typing "gla" finds nothing until the "zed" arrives. A picker has to answer on
 * the third keystroke, so it needs prefix matching, and prefix matching means
 * building the query by hand.
 *
 * Everything that is not a letter, a digit or a space is dropped rather than
 * escaped. A `tsquery` operator arriving from a search box is a syntax error at
 * best, and the tokens people type into a picker are words and codes.
 *
 * Returns `null` for a term with nothing searchable in it, which the caller
 * must treat as "no text filter" rather than "no results" — that is what makes
 * the idle pinned-and-recent state work.
 */
export function prefixTsQuery(term: string): string | null {
  // Split on **any** run of non-alphanumerics, not just whitespace.
  // `to_tsvector('simple', 'RST-300')` produces the two lexemes `rst` and
  // `300`; stripping the hyphen and keeping `RST300` as one token would ask
  // for a prefix that no vector in the table contains, and typing a product
  // code in full would find nothing at all.
  const tokens = term.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 0);

  if (tokens.length === 0) return null;

  return tokens.map((token) => `${token}:*`).join(' & ');
}

/**
 * A `LIKE` prefix pattern, with the wildcards escaped.
 *
 * This is not defensive tidiness: real product codes and tile sizes contain
 * both wildcards. `600x600_MATT` and a code with a `%` in it would otherwise
 * match half the catalogue, and the person typing them would have no idea why.
 *
 * The escape character is `\`, declared by the caller's `ESCAPE '\'` clause.
 */
export function likePrefix(term: string): string {
  const escaped = term.replace(/[\\%_]/g, (character) => `\\${character}`);
  return `${escaped}%`;
}

/**
 * The same escaping, matching anywhere in the value rather than only at the
 * start.
 *
 * For the fields a prefix is the wrong shape on: a product name somebody
 * remembers the middle of, or a colour they type as "iv" for "Ivory".
 */
export function likeContains(term: string): string {
  const escaped = term.replace(/[\\%_]/g, (character) => `\\${character}`);
  return `%${escaped}%`;
}
