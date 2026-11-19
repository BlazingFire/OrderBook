/**
 * Create product share (1.4 D3, R16): four to a page, every field but money,
 * photographs embedded, a placeholder when there is none. No database.
 */

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { Product } from '@orderbook/shared';

import {
  SHARE_PER_PAGE,
  chunkPages,
  shareCard,
  shareFileName,
  shareText,
  shareWeight,
} from '../src/domain/product-share.js';
import { renderProductShare } from '../src/pdf/product-share-renderer.js';

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: 'PR1',
    tenantId: 't',
    name: 'Damru',
    alias: 'Bell',
    categoryId: 'PC1',
    categoryName: 'One Piece Toilet',
    categoryCode: 'OPT',
    brand: 'Swisware',
    sortOrder: null,
    size: '600x600',
    code: 'D-1',
    weightKg: 12.5,
    colours: ['White', 'Ivory'],
    printSide: 'default',
    customFields: { Finish: 'Glossy', Empty: '' },
    isActive: true,
    images: [],
    ...overrides,
  } as unknown as Product;
}

describe('chunkPages', () => {
  it('puts four on a page: 9 products make 3 pages of 4, 4 and 1', () => {
    const pages = chunkPages(Array.from({ length: 9 }, (_, index) => index));
    expect(SHARE_PER_PAGE).toBe(4);
    expect(pages.map((page) => page.length)).toEqual([4, 4, 1]);
  });

  it('is no pages for nothing, and one page for exactly four', () => {
    expect(chunkPages([])).toEqual([]);
    expect(chunkPages([1, 2, 3, 4])).toHaveLength(1);
    expect(chunkPages([1, 2, 3, 4, 5])).toHaveLength(2);
  });
});

describe('shareCard', () => {
  it('carries every product field, and skips the empty ones', () => {
    const card = shareCard(product());
    expect(card.title).toBe('Damru');
    expect(card.subtitle).toBe('One Piece Toilet  |  Swisware');
    expect(card.fields).toEqual([
      { label: 'Alias', value: 'Bell' },
      // No Size: it is printed in no PDF (owner, 2026-11-18).
      { label: 'Code', value: 'D-1' },
      { label: 'Colours', value: 'White, Ivory' },
      { label: 'Weight', value: '12.5 kg' },
      { label: 'Finish', value: 'Glossy' },
    ]);
  });

  it('never prints the main-product code (OPT) anywhere on a card (R14)', () => {
    const card = shareCard(product(), undefined, shareText());
    const everything = [card.title, card.subtitle, ...card.fields.flatMap((field) => [field.label, field.value])].join('|');
    expect(everything).not.toMatch(/OPT/);
  });

  it('prints the sheet words from the text it is given, and a page line', () => {
    const text = shareText();
    const card = shareCard(product({ alias: 'Bell' } as Partial<Product>), undefined, text);
    const labels = card.fields.map((field) => field.label);
    expect(labels).toEqual(expect.arrayContaining([text.alias, text.code, text.colours, text.weight]));
    expect(text.page(2, 5)).toBe('Page 2 of 5');
  });

  it('prints a custom field by the company label, and by its key when it has none (1.4 rework)', () => {
    const labels: Record<string, string> = { Finish: 'Surface finish' };
    const card = shareCard(
      product({ customFields: { Finish: 'Glossy', other_key: 'x' } } as Partial<Product>),
      (key) => labels[key] ?? key,
    );
    expect(card.fields).toContainEqual({ label: 'Surface finish', value: 'Glossy' });
    expect(card.fields).toContainEqual({ label: 'other_key', value: 'x' });
    expect(card.fields.map((field) => field.label)).not.toContain('Finish');
  });

  it('leaves a weight out while the sub product has none, never printing zero', () => {
    const missing = product({ weightKg: null } as Partial<Product>);
    expect(shareWeight(missing)).toBeNull();
    expect(shareCard(missing).fields.map((field) => field.label)).not.toContain('Weight');
  });

  it('prints every colour the sub product is offered in, and no colours line when it has none', () => {
    const card = shareCard(product());
    expect(card.fields).toContainEqual({ label: 'Colours', value: 'White, Ivory' });

    const plain = shareCard(product({ colours: [] } as Partial<Product>));
    expect(plain.fields.map((field) => field.label)).not.toContain('Colours');
  });

  it('prints no money: nothing on a card is a price, rate or amount', () => {
    const text = JSON.stringify(shareCard(product())).toLowerCase();
    for (const word of ['price', 'rate', 'amount', 'mrp', '₹', 'rs.']) expect(text).not.toContain(word);
  });
});

describe('shareFileName', () => {
  it('is dated', () => expect(shareFileName('2026-10-03')).toBe('product-share-2026-10-03.pdf'));
});

function pageCount(pdf: Buffer): number {
  return (pdf.toString('latin1').match(/\/Type \/Page\b(?!s)/g) ?? []).length;
}

describe('renderProductShare', () => {
  it('draws a sheet of Latin text and embeds the Inter face it was measured in', async () => {
    const text = shareText();
    const pdf = await renderProductShare({
      company: 'Shubh Ceramics',
      caption: '2026-10-03',
      text,
      entries: [{ card: shareCard(product({ name: 'Damru', alias: 'Bell' } as Partial<Product>), undefined, text), photo: null }],
    });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    // Embedded, so the Latin words print as glyphs and not as Helvetica or boxes.
    expect(pdf.toString('latin1')).toMatch(/Inter/);
    expect(pdf.toString('latin1')).not.toMatch(/Devanagari/);
  });

  it('draws 9 products on 3 A4 pages', async () => {
    const entries = Array.from({ length: 9 }, (_, index) => ({
      card: shareCard(product({ id: `PR${index}`, name: `Model ${index}` })),
      photo: null,
    }));
    const pdf = await renderProductShare({ company: 'Test Ceramics', caption: '2026-10-03', entries });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pageCount(pdf)).toBe(3);
  });

  it('embeds a photograph when it has one, and none when it has not', async () => {
    const photo = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#336699' } })
      .jpeg()
      .toBuffer();
    const card = shareCard(product());
    const withPhoto = await renderProductShare({
      company: 'Test Ceramics',
      caption: 'x',
      entries: [{ card, photo }],
    });
    const without = await renderProductShare({
      company: 'Test Ceramics',
      caption: 'x',
      entries: [{ card, photo: null }],
    });
    expect(withPhoto.toString('latin1')).toContain('/Subtype /Image');
    expect(without.toString('latin1')).not.toContain('/Subtype /Image');
  });

  it('survives a photograph that is not an image: a grey box, not a failure', async () => {
    const pdf = await renderProductShare({
      company: 'Test Ceramics',
      caption: 'x',
      entries: [{ card: shareCard(product()), photo: Buffer.from('not an image') }],
    });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
