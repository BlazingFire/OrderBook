import { describe, expect, it } from 'vitest';

import { clampCopies, pdfFileName, printOptions } from '../lib/print-options.js';

const INSTALLED = ['HP LaserJet', 'Microsoft Print to PDF'];

describe('printOptions', () => {
  it('prints straight to an installed printer', () => {
    expect(printOptions({ deviceName: 'HP LaserJet' }, INSTALLED)).toMatchObject({
      silent: true,
      deviceName: 'HP LaserJet',
      pageSize: 'A4',
      printBackground: true,
    });
  });

  it('opens the dialog when no printer is named', () => {
    expect(printOptions({}, INSTALLED).silent).toBe(false);
    expect(printOptions({ deviceName: '' }, INSTALLED).silent).toBe(false);
    expect(printOptions(null, INSTALLED).silent).toBe(false);
  });

  it('opens the dialog for a printer that is no longer installed', () => {
    const result = printOptions({ deviceName: 'Unplugged Epson' }, INSTALLED);
    expect(result.silent).toBe(false);
    expect(result.deviceName).toBeUndefined();
  });

  it('ignores a name that is not a string', () => {
    expect(printOptions({ deviceName: 42 }, INSTALLED).silent).toBe(false);
  });

  it('asks for no margins so the sheet is not scaled down', () => {
    expect(printOptions({}, INSTALLED).margins).toEqual({ marginType: 'none' });
  });
});

describe('copies', () => {
  it('passes a whole number from 1 to 50, collated, to a named printer and to the dialog alike', () => {
    expect(printOptions({ deviceName: 'HP LaserJet', copies: 3 }, INSTALLED)).toMatchObject({ copies: 3, collate: true });
    expect(printOptions({ copies: 3 }, INSTALLED)).toMatchObject({ silent: false, copies: 3, collate: true });
    expect(printOptions({ copies: 1 }, INSTALLED).copies).toBe(1);
    expect(printOptions({ copies: 50 }, INSTALLED).copies).toBe(50);
  });

  it.each([0, -2, 51, 1000, 2.5, '4', null, undefined, NaN, Infinity, {}])('prints one copy for %s', (value) => {
    expect(printOptions({ copies: value }, INSTALLED).copies).toBe(1);
    expect(clampCopies(value)).toBe(1);
  });

  it('prints one copy when the request is missing or not an object', () => {
    expect(printOptions({}, INSTALLED).copies).toBe(1);
    expect(printOptions(null, INSTALLED)).toMatchObject({ copies: 1, collate: true });
    expect(printOptions('3', INSTALLED).copies).toBe(1);
  });
});

describe('pdfFileName', () => {
  it('turns separators and characters Windows refuses into hyphens, and ends in .pdf', () => {
    expect(pdfFileName('PO/2026-27/00001 dispatch')).toBe('PO-2026-27-00001 dispatch.pdf');
    expect(pdfFileName('a\\b:c*d?e"f<g>h|i')).toBe('a-b-c-d-e-f-g-h-i.pdf');
  });

  it('keeps a name that already ends in .pdf from ending in .pdf.pdf', () => {
    expect(pdfFileName('LD0001-filling.PDF')).toBe('LD0001-filling.pdf');
  });

  it('drops control characters, collapses spaces and trims dots', () => {
    expect(pdfFileName('  a\u0000\u001f  b   ')).toBe('a-- b.pdf');
    expect(pdfFileName('...')).toBe('note.pdf');
  });

  it('caps the name at 100 characters before the extension', () => {
    const result = pdfFileName('x'.repeat(300));
    expect(result).toBe(`${'x'.repeat(100)}.pdf`);
  });

  it('falls back to note.pdf for an empty or non-string name', () => {
    expect(pdfFileName('')).toBe('note.pdf');
    expect(pdfFileName('   ')).toBe('note.pdf');
    expect(pdfFileName(42)).toBe('note.pdf');
    expect(pdfFileName(undefined)).toBe('note.pdf');
    expect(pdfFileName({ toString: () => 'x' })).toBe('note.pdf');
  });
});
