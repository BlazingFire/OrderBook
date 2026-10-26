/**
 * Rust sidecar parity for CSV sheet parsing (`lib/spreadsheet-via-rust.ts`).
 *
 * `parseCsvViaRust` must answer exactly what `parseCsv` computes — including
 * blank lines as rows, so row numbers never shift — whether the binary is
 * present (Rust parses) or absent (TypeScript fallback). `readSheetRows` is
 * covered on CSV buffers because that is the wired production branch every
 * product, party and log import flows through.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { resetRustBridgeForTest, tryHelper } from '../src/lib/rust-bridge.js';
import { parseCsv, readSheetRows } from '../src/lib/spreadsheet.js';
import { parseCsvViaRust } from '../src/lib/spreadsheet-via-rust.js';

const TEXTS = [
  '',
  'a,b,c',
  'a;b\r\nc;d',
  '"a,b",c',
  '"a""b"',
  "'=SUM(A1),x",
  "'hello",
  '  padded  ,x\r\n',
  'a\n\nb\n',
  '"line1\nline2",x',
  '"a,""b""\nc",d',
  'name,alias\n"Two\nlines",  padded  \n',
  '﻿productCode,name,weightKg\r\n00123,"Ivory, Glossy",12.5\r\n',
];

afterEach(() => {
  delete process.env.ORDERBOOK_RUST_HELPER;
  resetRustBridgeForTest();
});

describe('parseCsv via Rust', () => {
  it('parses every sheet exactly like the TypeScript twin', async () => {
    for (const text of TEXTS) {
      await expect(parseCsvViaRust(text), JSON.stringify(text)).resolves.toEqual(parseCsv(text));
    }
  });

  it('reads CSV buffers through the wired readSheetRows branch', async () => {
    for (const text of TEXTS) {
      const buffer = Buffer.from(text, 'utf8');
      await expect(readSheetRows(buffer), JSON.stringify(text)).resolves.toEqual(
        parseCsv(text),
      );
    }
  });

  it('falls back to TypeScript when the helper is missing', async () => {
    process.env.ORDERBOOK_RUST_HELPER = 'C:\\definitely-not-here\\orderbook-helper.exe';
    resetRustBridgeForTest();
    await expect(tryHelper({ op: 'parseCsv', text: 'a' })).resolves.toBeNull();
    await expect(parseCsvViaRust('a,b')).resolves.toEqual([['a', 'b']]);
  });

  it('answers through a real binary when one is present', async () => {
    resetRustBridgeForTest();
    const { helperPath } = await import('../src/lib/rust-bridge.js');
    if (helperPath() === null) {
      await expect(tryHelper({ op: 'parseCsv', text: 'a' })).resolves.toBeNull();
      return;
    }
    expect(await tryHelper({ op: 'parseCsv', text: 'a,"b""c"\r\nd' })).toEqual([
      ['a', 'b"c'],
      ['d'],
    ]);
  });
});
