/**
 * Create product share (1.4 D3, R16): the chosen products as an A4 PDF to hand
 * to customers, four to a page with their photographs.
 *
 * Needs `products.view` and nothing else. The sheet carries no money and no
 * stock, so it is not an export of data in the `*.export` sense; who may see a
 * product is who may see it here. A product that was deleted since it was
 * chosen is skipped; if none is left the caller is told so.
 *
 * Photographs come from the Master's own image store (`resolveImageFile`), so
 * an Office asks the Master for the finished PDF and never needs the files.
 * `sharp` re-encodes the stored WebP as JPEG because PDFKit cannot read WebP.
 */

import sharp from 'sharp';
import type { Product } from '@orderbook/shared';

import { config } from '../config/index.js';
import { requirePermission, type ActorContext } from '../domain/actor.js';
import {
  SHARE_MAX_PRODUCTS,
  shareCard,
  shareFileName,
  shareText,
} from '../domain/product-share.js';
import { ValidationError } from '../lib/errors.js';
import { renderProductShare, type ShareEntry } from '../pdf/product-share-renderer.js';
import { findMasterConfig } from '../repositories/master-config.repository.js';
import * as customFieldRepo from '../repositories/custom-field.repository.js';
import * as productRepo from '../repositories/product.repository.js';
import { resolveImageFile } from './image.service.js';

/** Long enough edge for a card photo at print size, small enough for a sheet of 400 to stay light. */
const PHOTO_LONG_EDGE = 640;

function localIsoDate(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

async function photoOf(product: Product, actor: ActorContext): Promise<Buffer | null> {
  const image = product.images[0];
  if (!image) return null;
  try {
    const file = await resolveImageFile(image.id, 'large', actor);
    return await sharp(file.path)
      .resize({ width: PHOTO_LONG_EDGE, height: PHOTO_LONG_EDGE, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 82 })
      .toBuffer();
  } catch {
    // A missing or unreadable file is a grey box on the sheet, not a failed share.
    return null;
  }
}

/**
 * A product's custom field is stored under its key; the sheet prints the company's
 * label for it (the Fields screen). A key with no live definition prints as it is.
 */
export async function customFieldLabeler(tenantId: string): Promise<(key: string) => string> {
  const labels = new Map(
    (await customFieldRepo.definitionsFor(tenantId, 'product')).map((definition) => [
      definition.key,
      definition.label,
    ]),
  );
  return (key) => labels.get(key) ?? key;
}

export async function productSharePdf(
  ids: unknown,
  actor: ActorContext,
): Promise<{ fileName: string; bytes: Buffer }> {
  requirePermission(actor, 'products.view');

  const wanted = Array.isArray(ids)
    ? [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))]
    : [];
  if (wanted.length === 0) throw new ValidationError('validation.productShare.noProducts');
  if (wanted.length > SHARE_MAX_PRODUCTS) {
    throw new ValidationError('validation.productShare.tooMany', { max: SHARE_MAX_PRODUCTS });
  }

  const found = await productRepo.findProductsByIds(actor.tenantId, wanted, undefined, {
    includeDeleted: false,
  });
  // The order the person selected them in; a product that has gone is skipped.
  const products = wanted.flatMap((id) => {
    const product = found.get(id);
    return product && product.isActive ? [product] : [];
  });
  if (products.length === 0) throw new ValidationError('validation.productShare.noProducts');

  const company = (await findMasterConfig())?.company_name?.trim() || 'OrderBook';

  const labelOf = await customFieldLabeler(actor.tenantId);
  const text = shareText();

  const entries: ShareEntry[] = [];
  for (const product of products) {
    entries.push({ card: shareCard(product, labelOf, text), photo: await photoOf(product, actor) });
  }

  const date = localIsoDate(new Date());
  const bytes = await renderProductShare({ company, caption: date, entries, text });
  return { fileName: shareFileName(date), bytes };
}
