/**
 * The tooltip, per the Feedback artboard: a dark bubble with a small pointer, shown 400 ms
 * after the pointer comes to rest on something.
 *
 * Every tooltip in the product is a `title` attribute, so rather than wrap hundreds of
 * elements this layer takes them over: while the pointer is on an element with a `title`,
 * the attribute is parked in `data-ob-title` (so the browser's own tooltip does not show
 * as well) and given back when the pointer leaves. The words stay in `title` the rest of
 * the time, for tests, for code that reads it, and for anything that is never hovered.
 *
 * Mounted once, by `ToastProvider`, which both panels already wrap their whole app in.
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export const TOOLTIP_DELAY_MS = 400;

interface Tip {
  text: string;
  left: number;
  top: number;
  /** Under the element when there is no room above it. */
  below: boolean;
}

export function TooltipLayer() {
  const [tip, setTip] = useState<Tip | null>(null);

  useEffect(() => {
    let current: HTMLElement | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const release = (): void => {
      clearTimeout(timer);
      if (current) {
        const parked = current.dataset.obTitle;
        delete current.dataset.obTitle;
        // React may have set a new title while it was parked; that one wins.
        if (parked !== undefined && !current.hasAttribute('title')) {
          current.setAttribute('title', parked);
        }
      }
      current = null;
      setTip(null);
    };

    const onOver = (event: Event): void => {
      const target = event.target instanceof Element ? event.target : null;
      const element = target?.closest<HTMLElement>('[title], [data-ob-title]') ?? null;
      if (element === current) return;
      release();
      const text = element?.getAttribute('title');
      if (!element || !text) return;
      current = element;
      element.dataset.obTitle = text;
      element.removeAttribute('title');
      timer = setTimeout(() => {
        const rect = element.getBoundingClientRect();
        const below = rect.top < 48;
        setTip({
          text,
          left: Math.max(8, Math.min(rect.left, window.innerWidth - 8 - 280)),
          top: below ? rect.bottom + 8 : rect.top - 8,
          below,
        });
      }, TOOLTIP_DELAY_MS);
    };

    const onOut = (event: Event): void => {
      const next = (event as PointerEvent).relatedTarget;
      if (current && !(next instanceof Node && current.contains(next))) release();
    };

    document.addEventListener('pointerover', onOver);
    document.addEventListener('pointerout', onOut);
    // A click, a key or a scroll means the reader has moved on.
    document.addEventListener('pointerdown', release, true);
    document.addEventListener('keydown', release, true);
    window.addEventListener('scroll', release, true);
    window.addEventListener('blur', release);
    return () => {
      release();
      document.removeEventListener('pointerover', onOver);
      document.removeEventListener('pointerout', onOut);
      document.removeEventListener('pointerdown', release, true);
      document.removeEventListener('keydown', release, true);
      window.removeEventListener('scroll', release, true);
      window.removeEventListener('blur', release);
    };
  }, []);

  if (!tip) return null;
  return createPortal(
    <div
      className={`ob-tooltip${tip.below ? ' ob-tooltip--below' : ''}`}
      role="tooltip"
      style={{ left: tip.left, top: tip.top }}
    >
      {tip.text}
    </div>,
    document.body,
  );
}
