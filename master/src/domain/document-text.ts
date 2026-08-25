/**
 * Text preparation for the PDF renderer. Pure — no PDFKit, no I/O.
 *
 * PDFKit binds **one font per `text()` call**, so a line mixing Devanagari and
 * Latin — "शर्मा टाइल्स (Sharma Tiles)" is an ordinary party name here — has to
 * be split into runs *before* any ink is laid down. `splitByScript` is that
 * split; `primitives.ts#runText` walks the result switching faces on one
 * baseline.
 *
 * `formatDateForDocument` takes an ISO date **string** and formats from its
 * components. It never constructs a `Date`, which is what structurally
 * prevents the IST defect that once shifted every DATE column a day early:
 * `new Date('2026-08-20')` is midnight UTC, and `toISOString()` on a machine
 * east of UTC hands back the 19th.
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
 * which is how the renderer sets an ID column in the monospace face while
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

/** True when any part of the string needs the Devanagari face. */
export function containsDevanagari(text: string): boolean {
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (codePoint !== undefined && isDevanagari(codePoint)) return true;
  }
  return false;
}

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/**
 * `'2026-08-20'` → `'20 Aug 2026'`, by string surgery only.
 *
 * Anything that is not a well-formed `YYYY-MM-DD` comes back unchanged rather
 * than throwing: a document is not the place to discover that a column held
 * something unexpected, and printing the raw value is more useful to whoever
 * has to work out what went wrong than printing "Invalid Date".
 */
export function formatDateForDocument(isoDate: string | null): string {
  if (!isoDate) return '';

  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!match) return isoDate;

  const [, year, month, day] = match;
  const monthIndex = Number(month) - 1;
  const monthName = MONTH_NAMES[monthIndex];
  if (!monthName) return isoDate;

  return `${Number(day)} ${monthName} ${year}`;
}

/**
 * Money, from the smallest currency unit, in `en-IN` grouping.
 *
 * **Western Arabic digits, always.** Devanagari digits (`१२३`) are correct
 * Hindi orthography and completely wrong here: a total on a printed document
 * has to be comparable against a bank statement and a record id has to be
 * typeable into a search box.
 *
 * Returns `''` for `null`/`undefined` — which is what a redacted rate is,
 * since masking **deletes** the key rather than zeroing it. An empty cell says
 * "not shown"; a `0.00` would be a confident claim that the line is free.
 */
export function formatMinorUnits(minor: number | null | undefined): string {
  if (minor === null || minor === undefined) return '';

  const negative = minor < 0;
  const absolute = Math.abs(minor);
  const rupees = Math.trunc(absolute / 100);
  const paise = absolute % 100;

  return `${negative ? '-' : ''}${groupIndian(rupees)}.${String(paise).padStart(2, '0')}`;
}

/**
 * Indian digit grouping: the last three digits, then pairs — 12,34,567 rather
 * than 1,234,567. Written out rather than delegated to `Intl.NumberFormat`
 * because the renderer must produce the same bytes on every machine, and
 * `Intl`'s output depends on the ICU data the host Node was built with.
 */
function groupIndian(value: number): string {
  const digits = String(value);
  if (digits.length <= 3) return digits;

  const lastThree = digits.slice(-3);
  const rest = digits.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${lastThree}`;
}
