/**
 * The mark and its two moving jobs (the Mark, Icons and Motion artboards):
 * `Mark`, `BusyMark`, `Splash` and the CSS in `mark.css` that animates them.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BUSY_STAGGER_MS, BusyMark } from '../src/BusyMark.js';
import { Logo } from '../src/Logo.js';
import { Mark, markShowsGhosts } from '../src/Mark.js';
import { SPLASH_MS, SPLASH_STAGGER_MS, Splash } from '../src/Splash.js';

const css = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'mark.css'), 'utf8');

afterEach(cleanup);

const rects = (container: HTMLElement) => Array.from(container.querySelectorAll('rect'));

describe('Mark', () => {
  it('draws ten inked squares and two ghosts above 24 px', () => {
    const { container } = render(<Mark size={48} />);
    expect(rects(container)).toHaveLength(12);
    const ghosts = container.querySelector('[data-ghost]') as SVGGElement;
    expect(ghosts.querySelectorAll('rect')).toHaveLength(2);
    // The theme's opacity, from mark.css, unless one is given.
    expect(ghosts.style.opacity).toBe('');
    expect(css).toMatch(/\.ob-mark \[data-ghost\] \{\s*opacity: var\(--ob-mark-ghost\);/);
  });

  it('leaves the ghosts out at 24 px and below, so a small mark stays crisp', () => {
    for (const size of [24, 20, 16]) {
      const { container } = render(<Mark size={size} />);
      expect(rects(container), `${size} px`).toHaveLength(10);
      expect(container.querySelector('[data-ghost]')).toBeNull();
      cleanup();
    }
    expect(markShowsGhosts(25)).toBe(true);
    expect(markShowsGhosts(24)).toBe(false);
  });

  it('takes an ink and a ghost opacity, and a one-colour mark is ghost 0', () => {
    const { container } = render(<Mark size={96} ink="#ffffff" ghost={0} />);
    for (const group of Array.from(container.querySelectorAll('g'))) expect(group.getAttribute('fill')).toBe('#ffffff');
    expect((container.querySelector('[data-ghost]') as SVGGElement).style.opacity).toBe('0');
  });

  it('is decoration unless titled', () => {
    const { container, rerender } = render(<Mark />);
    const svg = container.querySelector('svg') as SVGSVGElement;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('role')).toBeNull();
    rerender(<Mark title="Order Book Software" />);
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toBe('Order Book Software');
  });

  it('is what the older Logo draws', () => {
    const { container } = render(<Logo size={40} color="#10161a" />);
    expect(rects(container)).toHaveLength(12);
    expect(container.querySelector('g')?.getAttribute('fill')).toBe('#10161a');
  });
});

describe('BusyMark', () => {
  it('pulses the ten squares in reading order, 70 ms apart, on a 700 ms loop', () => {
    const { container } = render(<BusyMark size={64} />);
    const delays = rects(container).map((rect) => rect.style.animationDelay);
    expect(delays).toEqual(Array.from({ length: 10 }, (_, i) => `${i * BUSY_STAGGER_MS}ms`));
    expect(BUSY_STAGGER_MS).toBe(70);
    expect(css).toMatch(/\.ob-busy rect \{[^}]*animation: ob-busy 700ms linear infinite;/);
    expect(css).toMatch(/\.ob-busy \{[^}]*opacity: 0\.4;/);
  });

  it('is announced when labelled and hidden inside a labelled button', () => {
    const { container, rerender } = render(<BusyMark label="Opening orders" />);
    const svg = container.querySelector('svg') as SVGSVGElement;
    expect(svg.getAttribute('role')).toBe('status');
    expect(svg.getAttribute('aria-label')).toBe('Opening orders');
    rerender(<BusyMark label="" />);
    expect(svg.getAttribute('role')).toBeNull();
    expect(svg.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('Splash', () => {
  const props = { wordmark: 'OrderBook', progress: 0.5, label: 'Starting', retryLabel: 'Retry', onRetry: () => {} };

  it('inks the ten squares 34 ms apart after the 240 ms outline, inside a hold that contains the whole entrance', () => {
    const { container } = render(<Splash {...props} onDone={() => {}} />);
    const cells = Array.from(container.querySelectorAll('.ob-splash-cell')) as SVGRectElement[];
    expect(cells.map((cell) => cell.style.animationDelay)).toEqual(
      Array.from({ length: 10 }, (_, i) => `${240 + i * SPLASH_STAGGER_MS}ms`),
    );
    // The outline traces all twelve squares, the ghosts' places included.
    expect(container.querySelector('.ob-splash-outline')?.getAttribute('d')?.match(/M/g)).toHaveLength(12);
    // Last arrival: the bar, at 700 ms over 280 ms.
    expect(SPLASH_MS).toBeGreaterThanOrEqual(980);
    expect(css).toMatch(/\.ob-splash-word \{[^}]*animation: ob-word 288ms var\(--e-standard\) 620ms both;/);
  });

  it('plays once: it hands the screen back after the hold', () => {
    vi.useFakeTimers();
    try {
      const onDone = vi.fn();
      render(<Splash {...props} onDone={onDone} />);
      vi.advanceTimersByTime(SPLASH_MS - 1);
      expect(onDone).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onDone).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('reduced motion', () => {
  const moving = ['.ob-busy rect', '.ob-splash-outline', '.ob-splash-cell', '.ob-splash-word'];

  it('stands every moving part of the mark still as its final frame, under both switches', () => {
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    const off = /((?:html\[data-motion='off'\] [^,{]+,?\s*)+)\{([^}]*)\}/.exec(css);
    for (const selector of moving) {
      expect(reduced, `reduced motion: ${selector}`).toContain(selector);
      const offSelectors = (off?.[1] ?? '').split(',').map((part) => part.trim());
      expect(offSelectors, `motion off: ${selector}`).toContain(`html[data-motion='off'] ${selector}`);
    }
    for (const block of [reduced, off?.[2] ?? '']) {
      expect(block).toContain('animation: none !important;');
      expect(block).toContain('opacity: 1;');
      expect(block).toContain('stroke-dashoffset: 0;');
    }
  });
});
