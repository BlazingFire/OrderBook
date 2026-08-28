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
import type { ImageVariant } from '@orderbook/shared';
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
  blurhash,
  width,
  height,
  alt,
  className,
  style,
}: {
  imageId: string;
  variant: ImageVariant;
  blurhash: string;
  width: number;
  height: number;
  alt: string;
  className?: string;
  style?: React.CSSProperties;
}) {
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
        src={`/uploads/images/${imageId}/${variant}`}
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
