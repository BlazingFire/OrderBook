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
 *
 * A variant that does not load (404 for files gone from the Master's disk, 503
 * from an Office offline with nothing cached, a file that will not decode)
 * swaps the blur for the neutral empty-photo tile: a blur is a promise of a
 * photo, and it must never stand in for one that is not coming.
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
  const [failed, setFailed] = useState(false);
  const placeholder = useMemo(() => placeholderDataUrl(blurhash), [blurhash]);

  // A different `imageId` means a different photo, not a slow-loading one —
  // reset so the old picture's placeholder doesn't flash in front of the new one.
  useEffect(() => {
    setLoaded(false);
    setFailed(false);
  }, [imageId]);

  return (
    <span
      className={className}
      data-photo-missing={failed ? 'true' : undefined}
      role={failed && alt ? 'img' : undefined}
      aria-label={failed && alt ? alt : undefined}
      style={{
        position: 'relative',
        display: 'block',
        width: '100%',
        aspectRatio: `${width || 1} / ${height || 1}`,
        overflow: 'hidden',
        borderRadius: 'var(--r-sm, 4px)',
        background: failed
          ? 'var(--bg-sunken)'
          : placeholder
            ? `center/cover url(${placeholder})`
            : 'var(--bg-subtle, #e8ebef)',
        contentVisibility: 'auto',
        ...style,
      }}
    >
      {!failed && (
        <img
          src={`/uploads/images/${imageId}/${chosen}`}
          alt={alt}
          loading="lazy"
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            opacity: loaded ? 1 : 0,
          }}
        />
      )}
    </span>
  );
}

/** The two sizes the new pending order draws, besides the list row's own 28 px (2rem). */
const THUMB_BOX = { 32: '2.286rem', 48: '3.429rem' } as const;

/**
 * A product's photo, small: its primary image (else the first), square and cropped, with the
 * blurhash painting first.
 *
 * One component for every list and form. With no `size` it is the list row's 28 px (W4); the new
 * pending order asks for 32 (picker and Added products rows) or 48 (the picked card). With no photo
 * it draws a neutral empty square (`fallback="blank"`, the lists' way, which keeps the column), a
 * square with the product's first letter (`"initial"`), or nothing (`"none"`, the order screen's).
 *
 * Lazy by way of `ProgressiveImage` (`loading="lazy"`, and a virtualised list only mounts the
 * rows on screen). On the Office the URL is served from the panel's own image cache, offline
 * too. 28 px rather than the full 32 px row, so the photo keeps a hairline of air inside it.
 */
export function ProductThumb({
  images,
  name,
  size,
  fallback = 'blank',
  alt,
}: {
  /** Absent on a row that has not carried its photos (a product made offline, not yet synced). */
  images?: readonly ProductImage[];
  name: string;
  size?: 32 | 48;
  fallback?: 'blank' | 'initial' | 'none';
  /** Defaults to the name; empty for a thumbnail that sits beside the name already. */
  alt?: string;
}) {
  const primary = images?.find((image) => image.isPrimary) ?? images?.[0];
  const box = size ? THUMB_BOX[size] : '2rem';
  if (!primary) {
    if (fallback === 'none') return null;
    return (
      <span
        className="ob-thumb ob-thumb--empty"
        data-product-thumb
        aria-hidden="true"
        style={size ? { width: box, height: box } : undefined}
      >
        {fallback === 'initial' ? name.trim().charAt(0).toUpperCase() : null}
      </span>
    );
  }
  return (
    <ProgressiveImage
      className="ob-thumb"
      imageId={primary.id}
      variant="micro"
      slotPx={size ?? 28}
      blurhash={primary.blurhash}
      width={1}
      height={1}
      alt={alt ?? name}
      // On the element itself: ProgressiveImage sets width 100%, which would win over a class.
      style={{ width: box, height: box, flex: 'none' }}
    />
  );
}
