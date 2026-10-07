/**
 * W4: every Products list row leads with the product's photo — the primary one, its
 * blurhash first — or a neutral empty square, and the column never drops.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProductImage } from '@orderbook/shared';

import { ProductThumb } from '../src/ProgressiveImage.js';

afterEach(cleanup);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const image = (id: string, isPrimary: boolean): ProductImage => ({
  id,
  productId: 'PR1',
  caption: null,
  isPrimary,
  sequence: isPrimary ? 1 : 2,
  width: 800,
  height: 600,
  checksum: 'x',
  blurhash: '',
  byteSize: 1,
  uploadedAt: '2026-10-07T00:00:00.000Z',
});

describe('ProductThumb', () => {
  it('shows the primary photo, lazily, at the small variant, named for the product', () => {
    const { container } = render(
      <ProductThumb images={[image('second', false), image('cover', true)]} name="102" />,
    );
    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toMatch(/^\/uploads\/images\/cover\/(micro|thumb)$/);
    expect(img?.getAttribute('loading')).toBe('lazy');
    expect(img?.getAttribute('alt')).toBe('102');
    expect(container.querySelector('.ob-thumb')).not.toBeNull();
  });

  it('falls back to the first photo when none is marked primary', () => {
    const { container } = render(<ProductThumb images={[image('only', false)]} name="x" />);
    expect(container.querySelector('img')?.getAttribute('src')).toMatch(/\/only\//);
  });

  it('is a neutral empty square, with no request, when the product has no photo', () => {
    const { container } = render(<ProductThumb images={[]} name="x" />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.ob-thumb--empty')).not.toBeNull();
  });
});

describe('the Products lists', () => {
  for (const file of ['ui/src/SubProductsScreen.tsx', 'office/web/src/screens/CatalogScreen.tsx']) {
    it(`${file} leads with the photo column and never drops it`, () => {
      const source = readFileSync(path.join(ROOT, file), 'utf8');
      const start = source.indexOf('const columns: DataTableColumn<Product>[] = [');
      expect(start).toBeGreaterThan(-1);
      const first = source.slice(start, source.indexOf('},', start));
      expect(first).toContain("key: 'photo'");
      expect(first).toContain('<ProductThumb');
      expect(first).not.toMatch(/priority:\s*[23]/);
    });
  }
});
