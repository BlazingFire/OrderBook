/**
 * The one URL a panel window may open a window of its own for: a lead's PDF on
 * this panel — `<origin>/api/leads/<id>/pdf` and nothing else, no query, no
 * fragment (`docs/catalogue/CATALOGUE_MODEL.md` §8).
 *
 * Here rather than in `shell.ts` because that window is given the PDF viewer
 * (`plugins: true`), and a rule that widens by accident — another origin,
 * another path — should fail a test, not wait for somebody to click it.
 * `shell.ts` imports `electron` and cannot run under the suite; this can.
 */
export function isLeadPdfUrl(origin: string, url: string): boolean {
  // `${origin}/`, not `origin` alone: that would accept `localhost:4100.evil`.
  return (
    url.startsWith(`${origin}/`) && /^\/api\/leads\/[^/?#]+\/pdf$/.test(url.slice(origin.length))
  );
}
