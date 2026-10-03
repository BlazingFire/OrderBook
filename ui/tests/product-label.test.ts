/**
 * R14: a product's name never carries its main-product code.
 *
 * `OPT` is the code of the main product One Piece Toilet. It has its own column
 * and its own field; it must not ride along in the label a list, a picker or a
 * detail prints for the product. The label is composed in one place
 * (`productLabel`), so that is where this is held.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { productLabel } from '../src/catalogueSummary.js';

const ROOT = path.resolve(__dirname, '..', '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.tsx?$/.test(full) ? [full] : [];
  });
}

describe('productLabel', () => {
  it('is the name, then the brand', () => {
    expect(productLabel('One Piece Toilet', 'Swisware+')).toBe('One Piece Toilet · Swisware+');
    expect(productLabel('One Piece Toilet')).toBe('One Piece Toilet');
    expect(productLabel(null)).toBe('');
  });
});

describe('no screen puts the main-product code into a product label', () => {
  const files = [...sources(path.join(ROOT, 'ui', 'src')), ...sources(path.join(ROOT, 'office', 'web', 'src'))];

  it('finds the sources it is meant to read', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('never passes a code to productLabel', () => {
    const offenders = files.filter((file) =>
      /productLabel\([^)]*(\.code|[cC]ategoryCode)/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('never joins a category code into display text with a middot', () => {
    const offenders = files.filter((file) =>
      /\[[^\]]*(\.code|[cC]ategoryCode)[^\]]*\]\s*\.filter\(Boolean\)\s*\.join\(' · '\)/.test(
        readFileSync(file, 'utf8'),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
