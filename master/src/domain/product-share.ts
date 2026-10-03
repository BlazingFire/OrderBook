/**
 * Create product share (1.4 D3, R16): the pure half. A share is an A4 PDF of the
 * chosen products, four to a page (2 x 2), each with its photograph and every
 * product field except money (the software carries none). The layout and the
 * fields are decided here; `pdf/product-share-renderer.ts` only draws them and
 * `services/product-share.service.ts` reads the products and photographs.
 *
 * The field labels and the page line are in the company's language (`shareText`), because
 * the sheet goes to its customers. The product's own words (its name, colours, custom
 * field values) are printed as the company wrote them.
 *
 * A card never prints the main product's software code (`OPT`): it is a column and a
 * field of its own, not part of how a product reads (R14, `ui/src/catalogueSummary.ts`).
 */

import { t, type Locale, type Product } from '@orderbook/shared';

/** Four products to a page, two across and two down. */
export const SHARE_PER_PAGE = 4;

/** The most products one share may hold: a guard against a runaway selection, not a design limit. */
export const SHARE_MAX_PRODUCTS = 400;

export interface ShareField {
  label: string;
  value: string;
}

export interface ShareCard {
  id: string;
  /** The product's name, big. */
  title: string;
  /** Its category and brand, under the name. */
  subtitle: string;
  fields: ShareField[];
}

/** Items split into pages of `perPage`, in order. An empty list is no pages. */
export function chunkPages<T>(items: readonly T[], perPage: number = SHARE_PER_PAGE): T[][] {
  const pages: T[][] = [];
  for (let start = 0; start < items.length; start += perPage) {
    pages.push(items.slice(start, start + perPage));
  }
  return pages;
}

function formatKg(value: number): string {
  // Up to three decimals, trailing zeros dropped: 1.5 kg, 2 kg, 0.125 kg.
  return `${Number(value.toFixed(3))} kg`;
}

function liveVariants(product: Product) {
  return product.variants.filter((variant) => variant.isActive);
}

/** The weight a customer is told: one figure, a range, or nothing while nobody has entered it. */
export function shareWeight(product: Product): string | null {
  const variants = liveVariants(product);
  if (variants.length === 0 || variants.some((variant) => variant.weightKg === null)) return null;
  const weights = variants.map((variant) => variant.weightKg as number);
  const low = Math.min(...weights);
  const high = Math.max(...weights);
  return low === high ? formatKg(low) : `${formatKg(low)} - ${formatKg(high)}`;
}

function customFieldText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/** The fixed words of the sheet, in one language. */
export interface ShareText {
  alias: string;
  size: string;
  code: string;
  colours: string;
  colour: string;
  anyColour: string;
  weight: string;
  /** "Page 2 of 5". */
  page: (page: number, total: number) => string;
  /** The PDF's document title. */
  title: (company: string) => string;
}

export function shareText(locale: Locale): ShareText {
  return {
    alias: t(locale, 'productShare.pdf.alias'),
    size: t(locale, 'productShare.pdf.size'),
    code: t(locale, 'productShare.pdf.code'),
    colours: t(locale, 'productShare.pdf.colours'),
    colour: t(locale, 'productShare.pdf.colour'),
    anyColour: t(locale, 'productShare.pdf.anyColour'),
    weight: t(locale, 'productShare.pdf.weight'),
    page: (page, total) => t(locale, 'productShare.pdf.page', { page, total }),
    title: (company) => t(locale, 'productShare.pdf.title', { company }),
  };
}

/** One product as the lines its card prints. A field with no value is left out, never printed empty. */
export function shareCard(
  product: Product,
  /** The company's label for a custom field's key (the Fields screen); a key with none prints as it is. */
  labelOf: (key: string) => string = (key) => key,
  text: ShareText = shareText('en'),
): ShareCard {
  const variants = liveVariants(product);
  const subtitle = [product.categoryName, product.brand].filter(Boolean).join('  |  ');

  const colours = variants.map((variant) => variant.label).filter((label): label is string => Boolean(label));

  const candidates: Array<[string, string | null | undefined]> = [
    [text.alias, product.alias],
    [text.size, product.size],
    [text.code, variants.map((variant) => variant.code).join(', ')],
    [text.colours, colours.length > 0 ? colours.join(', ') : null],
    [text.colour, product.multiColour ? text.anyColour : null],
    [text.weight, shareWeight(product)],
  ];

  const fields: ShareField[] = [];
  for (const [label, value] of candidates) {
    const text = value?.trim();
    if (text) fields.push({ label, value: text });
  }
  for (const [key, raw] of Object.entries(product.customFields ?? {})) {
    const text = customFieldText(raw);
    if (text) fields.push({ label: labelOf(key).trim() || key, value: text });
  }

  return { id: product.id, title: product.name, subtitle, fields };
}

/** `product-share-2026-10-03.pdf`. */
export function shareFileName(isoDate: string): string {
  return `product-share-${isoDate}.pdf`;
}
