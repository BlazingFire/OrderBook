/**
 * Rust sidecar parity for CSV rendering (`lib/csv-via-rust.ts`).
 *
 * Every vector asserts the byte-identical property the wiring relies on:
 * the helper path answers exactly what the TypeScript twin answers, whether
 * the binary is present (Rust renders) or absent (TypeScript fallback).
 * A `tryHelper` probe documents the no-binary state of this checkout.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { csvLines, toCsv } from '../src/lib/csv.js';
import { csvLinesViaRust, toCsvViaRust } from '../src/lib/csv-via-rust.js';
import { helperPath, resetRustBridgeForTest, tryHelper } from '../src/lib/rust-bridge.js';

const ROWS: Array<Array<unknown>> = [
  [],
  ['plain', 'a,b', 'say "hi"', 'line1\nline2', 'a\rb'],
  ['=SUM(A1)', '@home', '-5', '+91 98250', "'=x", "'hello", '=a,"b"'],
  [null, undefined, 0, 12.5, true, 'Gräs 🙃 tile'],
];

afterEach(() => {
  delete process.env.ORDERBOOK_RUST_HELPER;
  resetRustBridgeForTest();
});

describe('csv via Rust', () => {
  it('renders every row exactly like the TypeScript twin', async () => {
    await expect(csvLinesViaRust(ROWS)).resolves.toBe(csvLines(ROWS));
    await expect(csvLinesViaRust([])).resolves.toBe('');
  });

  it('renders a document exactly like toCsv', async () => {
    const headers = ['Name', 'Note'];
    await expect(toCsvViaRust(headers, ROWS)).resolves.toBe(toCsv(headers, ROWS));
    await expect(toCsvViaRust(headers, [])).resolves.toBe(toCsv(headers, []));
  });

  it('falls back to TypeScript when the helper is missing', async () => {
    process.env.ORDERBOOK_RUST_HELPER = 'C:\\definitely-not-here\\orderbook-helper.exe';
    resetRustBridgeForTest();
    await expect(tryHelper({ op: 'csv', rows: [['a']] })).resolves.toBeNull();
    await expect(csvLinesViaRust(ROWS)).resolves.toBe(csvLines(ROWS));
  });

  it('reports no helper binary on a checkout without a Rust build', async () => {
    if (process.env.ORDERBOOK_RUST_HELPER) delete process.env.ORDERBOOK_RUST_HELPER;
    resetRustBridgeForTest();
    const located = helperPath();
    if (located !== null) {
      // A built binary is present: it must answer the csv op byte-identically.
      const quoted = '"a,b"';
      expect(await tryHelper({ op: 'csv', rows: [['a,b']] })).toBe(`${quoted}\r\n`);
    } else {
      await expect(tryHelper({ op: 'csv', rows: [['a']] })).resolves.toBeNull();
    }
  });
});
