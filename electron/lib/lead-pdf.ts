/**
 * The URLs a panel window may open a window of its own for: a PDF on this panel
 * (`docs/catalogue/CATALOGUE_MODEL.md` §8). Two kinds, each an exact path:
 *
 * - a lead's PDF, `<origin>/api/leads/<id>/pdf`, with no query;
 * - a report's PDF, `<origin>/api/reports/<one of the 15 kinds>/pdf`, with a
 *   query only of the allowlisted keys below.
 *
 * Never a fragment. The route behind both answers `application/pdf` inline
 * whatever the query says, so a query cannot turn the window into anything else.
 *
 * Here rather than in `shell.ts` because that window is given the PDF viewer
 * (`plugins: true`), and a rule that widens by accident — another origin,
 * another path — should fail a test, not wait for somebody to click it.
 * `shell.ts` imports `electron` and cannot run under the suite; this can.
 */

/**
 * `REPORT_KINDS` in `@orderbook/shared`. Written out because this runs in the
 * shell, which takes only types from shared; `lead-pdf.test.ts` fails if the two
 * lists differ.
 */
export const PDF_REPORT_KINDS: readonly string[] = [
  'dispatches',
  'lead-outcomes',
  'top-parties',
  'by-user',
  'user-daily',
  'by-party',
  'party-dormant',
  'by-city',
  'by-product',
  'by-variant',
  'by-brand',
  'stage-ageing',
  'lead-sources',
  'conversion-time',
  'open-pending-orders',
];

/** What a report PDF's query may carry: the range, the subject, the columns and the page setup. */
export const PDF_QUERY_KEYS: readonly string[] = [
  'period',
  'fromMonth',
  'toMonth',
  'fromDate',
  'toDate',
  'subjectId',
  'limit',
  'columns',
  'totals',
  'paperSize',
  'orientation',
  'lang',
];

const LEAD_PATH = /^\/api\/leads\/[^/?#]+\/pdf$/;
const REPORT_PATH = new RegExp(`^/api/reports/(${PDF_REPORT_KINDS.join('|')})/pdf$`);
/** Characters a value may hold once decoded: ids, dates, `a,b` column lists. */
const QUERY_VALUE = /^[A-Za-z0-9._,:+-]{0,200}$/;

export function isPdfWindowUrl(origin: string, url: string): boolean {
  // `${origin}/`, not `origin` alone: that would accept `localhost:4100.evil`.
  if (!url.startsWith(`${origin}/`)) return false;
  const rest = url.slice(origin.length);
  if (rest.includes('#')) return false;

  const mark = rest.indexOf('?');
  const path = mark === -1 ? rest : rest.slice(0, mark);
  const query = mark === -1 ? null : rest.slice(mark + 1);

  if (LEAD_PATH.test(path)) return query === null;
  if (!REPORT_PATH.test(path)) return false;
  if (query === null) return true;

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(query);
  } catch {
    return false;
  }
  const seen = new Set<string>();
  for (const [key, value] of params) {
    if (!PDF_QUERY_KEYS.includes(key) || seen.has(key) || !QUERY_VALUE.test(value)) return false;
    seen.add(key);
  }
  return true;
}
