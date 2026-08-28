/**
 * How a picker orders its rows — the one scorer both sides use.
 *
 * The Master ranks with Postgres, which has the index; the Office panel ranks
 * in memory over its cached snapshot when the link is down. Those are two
 * different mechanisms answering the same question, and if they ordered
 * differently the picker would visibly reshuffle the moment a panel
 * reconnected. So the *shape* of the answer lives here: an exact prefix beats a
 * word-start beats a substring, and shorter beats longer at the same tier.
 *
 * Pure and free of both, so it can be unit-tested and so neither side has an
 * excuse to write its own.
 */

/** Higher is better. `0` means the row does not match at all. */
export const PICK_SCORE = {
  none: 0,
  substring: 1,
  wordStart: 2,
  prefix: 3,
  exact: 4,
} as const;

export type PickScore = (typeof PICK_SCORE)[keyof typeof PICK_SCORE];

/** True when `needle` occurs at the start of a word in `text`. */
function isWordStart(text: string, needle: string): boolean {
  const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

  for (let index = text.indexOf(needle); index !== -1; index = text.indexOf(needle, index + 1)) {
    if (index === 0) return true;
    if (!LETTER_OR_DIGIT.test(text[index - 1] ?? '')) return true;
  }

  return false;
}

function scoreOne(haystack: string, needle: string): PickScore {
  if (!haystack) return PICK_SCORE.none;

  const text = haystack.toLowerCase();
  if (text === needle) return PICK_SCORE.exact;
  if (text.startsWith(needle)) return PICK_SCORE.prefix;

  // A word start, not merely a substring: typing "mat" should rank "Ivory Matt"
  // above "Formatted", which contains the same three letters in the middle of a
  // word nobody was thinking of.
  //
  // Scanned rather than matched with a built regex: the term comes straight
  // from a search box, real product codes contain `(`, `+` and `.`, and a
  // regex built from unescaped input throws on the third keystroke of somebody's
  // ordinary search.
  if (isWordStart(text, needle)) return PICK_SCORE.wordStart;

  return text.includes(needle) ? PICK_SCORE.substring : PICK_SCORE.none;
}

/**
 * The best score any of a row's searchable fields achieves.
 *
 * Best rather than sum: a product whose *code* is an exact match should beat
 * one whose name merely contains the term, and adding the fields up would let a
 * row win by being vaguely relevant in four places.
 */
export function pickScore(fields: ReadonlyArray<string | null | undefined>, term: string): PickScore {
  const needle = term.trim().toLowerCase();
  if (!needle) return PICK_SCORE.none;

  let best: PickScore = PICK_SCORE.none;
  for (const field of fields) {
    const score = scoreOne(String(field ?? ''), needle);
    if (score > best) best = score;
  }

  return best;
}

/**
 * Order two scored rows: better score first, then shorter label, then by label.
 *
 * The length tiebreak is what makes a picker feel right — at the same tier, the
 * shorter of two matches is nearly always the one somebody meant, because the
 * term they typed is a larger fraction of it. The final alphabetical tiebreak
 * only exists so the order is stable rather than dependent on the order rows
 * arrived in.
 */
export function comparePicked(
  a: { score: PickScore; label: string },
  b: { score: PickScore; label: string },
): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.label.length !== b.label.length) return a.label.length - b.label.length;
  return a.label.localeCompare(b.label);
}
