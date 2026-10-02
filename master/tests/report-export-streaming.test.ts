/**
 * The two big exports at their caps must not freeze the Master.
 *
 * A report can be a hundred thousand rows of Excel or ten thousand of PDF
 * (`REPORT_EXPORT_CAPS`). Both are built in the one Node process that also
 * answers every Office panel's socket, so a build that never lets go of the
 * event loop stops every panel until it finishes. The workbook is written row by
 * row with a turn of the loop every `YIELD_EVERY_ROWS`, and the PDF between
 * pages; this measures the longest single stall each one causes. Pure — no
 * database — so it always runs.
 */

import { REPORT_EXPORT_CAPS } from '@orderbook/shared';
import { describe, expect, it } from 'vitest';

import { renderReportPdf } from '../src/pdf/table-renderer.js';
import { readSheetRows, streamXlsxTable } from '../src/lib/spreadsheet.js';

/**
 * The longest the event loop was held, in milliseconds, while `work` ran: a
 * ticker that asks to run every 5 ms, and the biggest gap it was kept waiting.
 * (`monitorEventLoopDelay` reads the same thing but reports nothing under this
 * test runner, which is why the measurement is spelt out.)
 */
async function longestStall(work: () => Promise<unknown>): Promise<number> {
  const TICK = 5;
  let last = performance.now();
  let longest = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    longest = Math.max(longest, now - last - TICK);
    last = now;
  }, TICK);
  try {
    await work();
    // A stall is only seen when the held-up tick finally runs.
    await new Promise<void>((resolve) => setTimeout(resolve, 3 * TICK));
  } finally {
    clearInterval(timer);
  }
  return longest;
}

/**
 * Held to well under a second because the plan's own bound is a second and the
 * loop is also what answers every panel: with the yields taken out, the build
 * holds it for roughly 0.8–0.9 s here, with them about 0.06 s.
 */
const MAX_STALL_MS = 400;

describe('the capped exports yield to the event loop', () => {
  it('writes the largest Excel report without holding the loop for long', async () => {
    const rows = Array.from({ length: REPORT_EXPORT_CAPS.xlsx }, (_, index): Array<string | number> => [
      `Party ${index}`,
      'Morbi',
      index % 50,
      (index % 50) * 10,
      (index % 50) * 2.5,
    ]);

    let bytes: Buffer = Buffer.alloc(0);
    const stall = await longestStall(async () => {
      bytes = await streamXlsxTable({
        sheetName: 'By party',
        columns: ['Party', 'City', 'Orders', 'Pieces', 'Weight (kg)'].map((header) => ({ header, width: 16 })),
        rows,
      });
    });

    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(stall).toBeLessThan(MAX_STALL_MS);
  }, 180_000);

  it('writes a workbook that reads back with its header, its numbers as numbers and its last row', async () => {
    const rows = Array.from({ length: 5000 }, (_, index): Array<string | number> => [`Party ${index}`, index, index * 2.5]);
    const bytes = await streamXlsxTable({
      sheetName: 'Check',
      columns: ['Party', 'Orders', 'Weight (kg)'].map((header) => ({ header, width: 16 })),
      rows,
    });

    const read = await readSheetRows(bytes);
    expect(read).toHaveLength(5001);
    expect(read[0]).toEqual(['Party', 'Orders', 'Weight (kg)']);
    expect(read[1]).toEqual(['Party 0', '0', '0']);
    expect(read[5000]).toEqual(['Party 4999', '4999', '12497.5']);
  }, 60_000);

  it('draws the largest PDF report without holding the loop for long', async () => {
    const rows = Array.from({ length: REPORT_EXPORT_CAPS.pdf }, (_, index) => [
      `Party ${index}`,
      'Morbi',
      String(index % 50),
      String((index % 50) * 10),
    ]);

    let bytes: Buffer = Buffer.alloc(0);
    const stall = await longestStall(async () => {
      bytes = await renderReportPdf({
        title: 'By party',
        columns: [
          { label: 'Party' },
          { label: 'City' },
          { label: 'Orders', numeric: true },
          { label: 'Pieces', numeric: true },
        ],
        rows,
        paperSize: 'a4',
        orientation: 'landscape',
      });
    });

    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(stall).toBeLessThan(MAX_STALL_MS);
  }, 180_000);
});
