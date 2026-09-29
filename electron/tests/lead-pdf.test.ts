/**
 * The shell's one exception to "nothing opens a window": a lead's PDF
 * (`docs/catalogue/CATALOGUE_MODEL.md` §8). That window gets the PDF viewer,
 * so the rule must stay exactly one path on exactly this panel.
 */

import { describe, expect, it } from 'vitest';

import { isLeadPdfUrl } from '../lib/lead-pdf.js';

const ORIGIN = 'http://localhost:4100';

describe('which URL may open a PDF window', () => {
  it("allows a lead's PDF on this panel", () => {
    expect(isLeadPdfUrl(ORIGIN, `${ORIGIN}/api/leads/L-0001/pdf`)).toBe(true);
    expect(isLeadPdfUrl(ORIGIN, `${ORIGIN}/api/leads/L-TMP%201/pdf`)).toBe(true);
  });

  it.each([
    ['another panel', 'http://localhost:4101/api/leads/L-1/pdf'],
    ['a look-alike host', 'http://localhost:4100.evil/api/leads/L-1/pdf'],
    ['a query', `${ORIGIN}/api/leads/L-1/pdf?x=1`],
    ['a fragment', `${ORIGIN}/api/leads/L-1/pdf#page=2`],
    ['a longer path', `${ORIGIN}/api/leads/L-1/pdf/more`],
    ['a nested id', `${ORIGIN}/api/leads/a/b/pdf`],
    ['no id', `${ORIGIN}/api/leads//pdf`],
    ['another record', `${ORIGIN}/api/orders/O-1/pdf`],
    ['the panel itself', `${ORIGIN}/`],
  ])('refuses %s', (_, url) => {
    expect(isLeadPdfUrl(ORIGIN, url)).toBe(false);
  });
});
