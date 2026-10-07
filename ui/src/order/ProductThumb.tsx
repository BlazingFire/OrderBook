/**
 * A product's photo, small: 32 px in a picker row, 48 px on the selected product's card.
 *
 * The blurhash paints at once and the right variant (`variantForSlot`) loads over it, through the
 * kit's `ProgressiveImage`. A product with no photo draws nothing, so a row keeps its layout; a
 * screen that wants the column to hold its width anyway passes `name` and gets an initial-letter
 * tile of the same size instead.
 */

import type { ProductImage } from '@orderbook/shared';

import { ProgressiveImage } from '../ProgressiveImage.js';
import './order.css';

export function ProductThumb({
  image,
  size,
  alt = '',
  name,
}: {
  /** The product's primary image, or nothing (`undefined`, `null`, an empty gallery's `[0]`). */
  image: ProductImage | undefined | null;
  size: 32 | 48;
  /** Empty for a decorative thumbnail (the product's name is already beside it). */
  alt?: string;
  /** Given: with no photo, a tile with the product's first letter instead of nothing. */
  name?: string;
}) {
  if (!image) {
    if (!name) return null;
    return (
      <span
        className={`ob-order-thumb ob-order-thumb--${size} ob-order-thumb--initial`}
        data-product-thumb
        aria-hidden="true"
      >
        {name.trim().charAt(0).toUpperCase()}
      </span>
    );
  }
  return (
    <span className={`ob-order-thumb ob-order-thumb--${size}`} data-product-thumb>
      <ProgressiveImage
        imageId={image.id}
        variant="thumb"
        slotPx={size}
        blurhash={image.blurhash}
        width={image.width}
        height={image.height}
        alt={alt}
        style={{ aspectRatio: '1 / 1' }}
      />
    </span>
  );
}
