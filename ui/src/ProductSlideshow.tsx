/**
 * The product band on Basic Home (2026-10-08, both panels): a strip of product photos, small
 * enough to share a row with the notice band.
 *
 * What it shows is the panel's choice (`homeProducts`): today's "Sell today" products when the
 * entry has some, otherwise sub products that have photos, a different two dozen each day
 * (`featuredProducts`). A card is the photo, the name and the code; pressing it opens the product.
 *
 * As many whole cards as the band is wide (measured; four where nothing can be measured), and
 * when there are more than fit it turns over by one every 4 s, the notice band's carousel rules:
 * paused while the pointer is over it or focus is inside it, a stop / start button, previous and
 * next, the region silent while it turns by itself, and under reduced motion (the OS or the app's
 * switch) it never moves by itself. Nothing to show, and it draws nothing.
 */

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import {
  sellTodayFor,
  sellTodayProductOf,
  type Product,
  type SellToday,
  type SellTodayProduct,
} from '@orderbook/shared';

import { t } from './i18n.js';
import { Icon } from './icons.js';
import { ProgressiveImage } from './ProgressiveImage.js';

export const PRODUCT_SLIDE_MS = 4000;
/** A card's width in rem (the CSS's `.ob-prodshow-card` basis), for counting how many fit. */
const CARD_REM = 10;
const GAP_REM = 0.5714;

/** A day-stable shuffle key, so the selection changes each day but not on every render. */
function dayHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Live sub products with a photo, a different selection of at most `limit` each day. */
export function featuredProducts(products: readonly Product[], today: string, limit = 24): SellTodayProduct[] {
  return products
    .filter((product) => product.isActive && product.images.length > 0)
    .map((product) => ({ product, key: dayHash(`${today}:${product.id}`) }))
    .sort((a, b) => a.key - b.key)
    .slice(0, limit)
    .map(({ product }) => sellTodayProductOf(product));
}

/** What the band shows: today's entry's products when it has some, else the featured ones. */
export function homeProducts(
  entries: readonly SellToday[] | undefined,
  catalogue: readonly Product[],
  today: string,
): { products: SellTodayProduct[]; sellToday: SellToday | null } {
  const entry = sellTodayFor(entries, today);
  if (entry && entry.products.length > 0) return { products: entry.products, sellToday: entry };
  return { products: featuredProducts(catalogue, today), sellToday: null };
}

function motionReduced(): boolean {
  if (document.documentElement.dataset.motion === 'off') return true;
  return typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}

export interface ProductSlideshowProps {
  products: readonly SellTodayProduct[];
  /** Today's entry, when the products are its: the band is headed "Sell today" and its headline. */
  sellToday?: Pick<SellToday, 'title'> | null;
  /** Opens a product. Absent: the cards are not buttons. */
  onOpen?: (id: string) => void;
}

export function ProductSlideshow({ products, sellToday, onOpen }: ProductSlideshowProps) {
  const [start, setStart] = useState(0);
  const [perView, setPerView] = useState(4);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [stopped, setStopped] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const trackId = useId();
  const hasProducts = products.length > 0;

  // How many whole cards fit, kept as the band is resized. No ResizeObserver (jsdom): four.
  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track || typeof ResizeObserver === 'undefined') return undefined;
    const measure = () => {
      const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 14;
      const fit = Math.floor((track.clientWidth + GAP_REM * rootPx) / ((CARD_REM + GAP_REM) * rootPx));
      setPerView(Math.max(1, fit));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    return () => observer.disconnect();
  }, [hasProducts]);

  const count = products.length;
  const shown = Math.min(perView, count);
  const canRotate = count > shown && !motionReduced();
  const rotating = canRotate && !stopped && !hovered && !focused;
  const first = count === 0 ? 0 : start % count;

  useEffect(() => {
    if (!rotating) return undefined;
    const timer = setTimeout(() => setStart((value) => (value + 1) % count), PRODUCT_SLIDE_MS);
    return () => clearTimeout(timer);
  }, [rotating, first, count]);

  if (count === 0) return null;
  const visible = Array.from({ length: shown }, (_, index) => products[(first + index) % count]!);
  const go = (step: number) => setStart(((first + step) % count + count) % count);

  return (
    <section
      className="ob-prodshow"
      aria-roledescription="carousel"
      aria-label={sellToday ? t('productShow.sellToday') : t('productShow.label')}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      <div className="ob-prodshow-head">
        <span className="ob-eyebrow">{sellToday ? t('productShow.sellToday') : t('productShow.featured')}</span>
        {sellToday && (
          <span className="ob-prodshow-headline" title={sellToday.title}>
            {sellToday.title}
          </span>
        )}
      </div>

      <div id={trackId} ref={trackRef} className="ob-prodshow-track" aria-live={rotating ? 'off' : 'polite'}>
        {visible.map((product, index) => {
          const face = (
            <>
              {product.image ? (
                <ProgressiveImage
                  className="ob-prodshow-photo"
                  imageId={product.image.id}
                  variant="micro"
                  slotPx={56}
                  blurhash={product.image.blurhash}
                  width={1}
                  height={1}
                  alt=""
                />
              ) : (
                <span className="ob-prodshow-photo ob-prodshow-photo--empty" aria-hidden="true">
                  {product.name.trim().charAt(0).toUpperCase()}
                </span>
              )}
              <span className="ob-prodshow-text">
                <span className="ob-prodshow-name">{product.name}</span>
                {/* The code alone: a size such as "L-16, H-31" would not fit a card this small (the pop-up has it). */}
                {product.code && <span className="ob-prodshow-meta">{product.code}</span>}
              </span>
            </>
          );
          return (
            <div
              // By product, so turning over moves the cards rather than remounting them.
              key={product.id}
              role="group"
              aria-roledescription="slide"
              aria-label={t('notices.slideshow.slide', { index: ((first + index) % count) + 1, count })}
              className="ob-prodshow-slide"
            >
              {onOpen ? (
                <button
                  type="button"
                  className="ob-prodshow-card"
                  data-product={product.id}
                  title={t('productShow.open', { name: product.name })}
                  onClick={() => onOpen(product.id)}
                >
                  {face}
                </button>
              ) : (
                <span className="ob-prodshow-card" data-product={product.id}>
                  {face}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {count > shown && (
        <div className="ob-slideshow-controls">
          {canRotate && (
            <button
              type="button"
              className="ob-icon-btn"
              aria-label={stopped ? t('productShow.play') : t('productShow.pause')}
              title={stopped ? t('productShow.play') : t('productShow.pause')}
              onClick={() => setStopped((value) => !value)}
            >
              <svg width={16} height={16} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                {stopped ? <path d="M5 3.5v9l7-4.5z" /> : <path d="M4.5 3.5h2.5v9H4.5zM9 3.5h2.5v9H9z" />}
              </svg>
            </button>
          )}
          <button
            type="button"
            className="ob-icon-btn"
            aria-controls={trackId}
            aria-label={t('productShow.previous')}
            title={t('productShow.previous')}
            onClick={() => go(-1)}
          >
            <Icon name="chevron-left" />
          </button>
          <button
            type="button"
            className="ob-icon-btn"
            aria-controls={trackId}
            aria-label={t('productShow.next')}
            title={t('productShow.next')}
            onClick={() => go(1)}
          >
            <Icon name="chevron-right" />
          </button>
        </div>
      )}
    </section>
  );
}
