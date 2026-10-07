/**
 * Renders one product image variant with the "never a visible loading state"
 * rule from `7-IMAGE-PIPELINE.md` §5, adapted for a browser client instead of
 * an Electron renderer reading local disk directly:
 *
 *   1. A blurhash placeholder paints in the same frame — decoded once per
 *      distinct hash into a data URL, cached module-wide (§5.5's "one shared
 *      in-memory decode cache", here keyed by hash instead of by file).
 *   2. `<img src="/uploads/images/:id/:variant">` — same-origin, so on this
 *      panel it resolves to a local disk read (this panel's own server;
 *      `office/src/http/app.ts` serves from its own on-disk cache, fetching
 *      from the Master once on a miss and caching thereafter) or, on the
 *      Master's own UI, a permission-gated route reading local disk directly.
 *      No resize ever happens here — `variant` must already be the right size
 *      for this slot (§5.3's contract), never downscaled by CSS.
 *
 * No fade-in: swapping the `<img>` in front of the placeholder is a single
 * paint, not an animation — a transition here would itself be the kind of
 * visible loading state §5.6 forbids.
 */

import { useEffect, useMemo, useState } from 'react';
import { variantForSlot, type ImageVariant, type ProductImage } from '@orderbook/shared';
import { decode } from 'blurhash';

const placeholderCache = new Map<string, string>();

function placeholderDataUrl(hash: string): string | null {
  if (!hash) return null;
  const cached = placeholderCache.get(hash);
  if (cached) return cached;

  try {
    const size = 16;
    const pixels = decode(hash, size, size);
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels), size, size), 0, 0);
    const url = canvas.toDataURL();
    placeholderCache.set(hash, url);
    return url;
  } catch {
    return null;
  }
}

export function ProgressiveImage({
  imageId,
  variant,
  slotPx,
  blurhash,
  width,
  height,
  alt,
  className,
  style,
}: {
  imageId: string;
  /** The variant to fetch when `slotPx` is not given. */
  variant: ImageVariant;
  /**
   * How wide this image renders, in CSS pixels, so the right variant can be
   * chosen for a retina screen.
   *
   * The design px of the slot, not a measured one: at every scale this product
   * offers, a slot stays inside the same variant's long edge, so measuring
   * would add a layout read and change nothing. Deliberately **not** `srcset` —
   * see `variantForSlot`.
   */
  slotPx?: number;
  blurhash: string;
  width: number;
  height: number;
  alt: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const chosen =
    slotPx === undefined
      ? variant
      : variantForSlot(slotPx, typeof window === 'undefined' ? 1 : window.devicePixelRatio);

  const [loaded, setLoaded] = useState(false);
  const placeholder = useMemo(() => placeholderDataUrl(blurhash), [blurhash]);

  // A different `imageId` means a different photo, not a slow-loading one —
  // reset so the old picture's placeholder doesn't flash in front of the new one.
  useEffect(() => setLoaded(false), [imageId]);

  return (
    <span
      className={className}
      style={{
        position: 'relative',
        display: 'block',
        width: '100%',
        aspectRatio: `${width || 1} / ${height || 1}`,
        overflow: 'hidden',
        borderRadius: 'var(--r-sm, 4px)',
        background: placeholder ? `center/cover url(${placeholder})` : 'var(--bg-subtle, #e8ebef)',
        contentVisibility: 'auto',
        ...style,
      }}
    >
      <img
        src={`/uploads/images/${imageId}/${chosen}`}
        alt={alt}
        loading="lazy"
        decoding="async"
        onLoad={() => setLoaded(true)}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          opacity: loaded ? 1 : 0,
        }}
      />
    </span>
  );
}

/**
 * A product's photo at list-row size (W4): its primary image (else the first), square and
 * cropped, with the blurhash painting first; a neutral empty square when it has no photo.
 *
 * Lazy by way of `ProgressiveImage` (`loading="lazy"`, and a virtualised list only mounts the
 * rows on screen). On the Office the URL is served from the panel's own image cache, offline
 * too. 28 px rather than the full 32 px row, so the photo keeps a hairline of air inside it.
 */
export function ProductThumb({
  images,
  name,
}: {
  /** Absent on a row that has not carried its photos (a product made offline, not yet synced). */
  images?: readonly ProductImage[];
  name: string;
}) {
  const primary = images?.find((image) => image.isPrimary) ?? images?.[0];
  if (!primary) return <span className="ob-thumb ob-thumb--empty" aria-hidden="true" />;
  return (
    <ProgressiveImage
      className="ob-thumb"
      imageId={primary.id}
      variant="micro"
      slotPx={28}
      blurhash={primary.blurhash}
      width={1}
      height={1}
      alt={name}
      // On the element itself: ProgressiveImage sets width 100%, which would win over a class.
      style={{ width: '2rem', height: '2rem', flex: 'none' }}
    />
  );
}
