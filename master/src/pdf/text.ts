/**
 * Text preparation for the PDF primitives. Pure — no PDFKit, no I/O.
 *
 * PDFKit binds **one font per `text()` call**, so a line mixing Devanagari and
 * Latin — "शर्मा टाइल्स (Sharma Tiles)" is an ordinary party name here — has to
 * be split into runs *before* any ink is laid down. `splitByScript` is that
 * split; `primitives.ts#runText` walks the result switching faces on one
 * baseline.
 */

/** Which vendored face a run of text needs. */
export type ScriptTag = 'body' | 'devanagari' | 'mono';

export interface ScriptRun {
  text: string;
  script: ScriptTag;
}

/**
 * Devanagari, plus the Vedic Extensions and Devanagari Extended blocks that
 * carry combining marks a real Hindi string can contain.
 */
function isDevanagari(codePoint: number): boolean {
  return (
    (codePoint >= 0x0900 && codePoint <= 0x097f) || // Devanagari
    (codePoint >= 0xa8e0 && codePoint <= 0xa8ff) || // Devanagari Extended
    (codePoint >= 0x1cd0 && codePoint <= 0x1cff) // Vedic Extensions
  );
}

/**
 * Characters that belong to whichever run they find themselves in — spaces,
 * punctuation, digits. Forcing a face change for the space between two
 * Devanagari words would produce two runs where one is correct, and worse,
 * would break the shaper's view of the word boundary.
 */
function isNeutral(codePoint: number): boolean {
  const char = String.fromCodePoint(codePoint);
  return /[\s\d!-/:-@[-`{-~₹–—…]/u.test(char);
}

/**
 * Split a string into consecutive same-script runs.
 *
 * `mono` is never inferred from the characters — a record id and a product
 * code are Latin, and telling them apart from prose by codepoint is not
 * possible. The caller asks for `mono` explicitly by passing a `defaultScript`,
 * which is how a renderer sets an ID column in the monospace face while
 * leaving a party name in the body face.
 */
export function splitByScript(text: string, defaultScript: ScriptTag = 'body'): ScriptRun[] {
  if (text.length === 0) return [];

  const runs: ScriptRun[] = [];

  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) continue;

    const open = runs[runs.length - 1];

    // A neutral character extends whatever run is open, and only starts a new
    // one when it is the first thing in the string.
    const script: ScriptTag = isNeutral(codePoint)
      ? (open?.script ?? defaultScript)
      : isDevanagari(codePoint)
        ? 'devanagari'
        : defaultScript;

    if (open && open.script === script) {
      open.text += char;
    } else {
      runs.push({ text: char, script });
    }
  }

  return runs;
}
