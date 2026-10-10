/**
 * The mark and its two moving jobs (the Mark, Icons and Motion artboards):
 * `Mark`, `BusyMark`, `Splash` and the CSS in `mark.css` that animates them.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BUSY_STAGGER_MS, BusyMark } from '../src/BusyMark.js';
import { Logo } from '../src/Logo.js';
import { Mark, markShowsGhosts } from '../src/Mark.js';
import { SPLASH_FINISH_MS, SPLASH_MIN_MS, SPLASH_STAGGER_MS, Splash } from '../src/Splash.js';

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

  it('is an inline glyph at 16 px and below: the text colour, square corners, full strength resting at 25 %', () => {
    const { container } = render(<BusyMark size={14} label="" />);
    const svg = container.querySelector('svg') as SVGSVGElement;
    expect(svg.getAttribute('class')).toBe('ob-busy ob-busy--inline');
    expect(container.querySelector('g')?.getAttribute('fill')).toBe('currentColor');
    expect(rects(container).every((rect) => rect.getAttribute('rx') === '0')).toBe(true);
    expect(css).toMatch(/\.ob-busy--inline \{\s*opacity: 1;/);
    expect(css).toMatch(/\.ob-busy--inline rect \{\s*opacity: 0\.25;\s*animation-name: ob-busy-inline;/);

    cleanup();
    const large = render(<BusyMark size={24} label="" />).container.querySelector('svg') as SVGSVGElement;
    expect(large.getAttribute('class')).toBe('ob-busy');
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
  const props = { program: 'office' as const, version: '1.4.6', retryLabel: 'Retry', onRetry: () => {} };

  it('drops the ten squares in bottom row first, 85 ms apart, and spells the wordmark letter by letter', () => {
    const { container, getByText } = render(<Splash {...props} company="Smruti Ceramics" ready={false} onDone={() => {}} />);
    const cells = Array.from(container.querySelectorAll('.ob-splash-cell')) as SVGRectElement[];
    expect(cells.map((cell) => cell.style.animationDelay)).toEqual(
      Array.from({ length: 10 }, (_, i) => `${750 + i * SPLASH_STAGGER_MS}ms`),
    );
    expect(cells[0]?.getAttribute('y')).toBe('16');
    expect(cells[9]?.getAttribute('y')).toBe('4');
    expect(container.querySelectorAll('.ob-splash-draw')).toHaveLength(12);
    expect(container.querySelectorAll('.ob-splash-ghost')).toHaveLength(2);
    expect(container.querySelector('h1')?.getAttribute('aria-label')).toBe('OrderBook');
    expect(container.querySelectorAll('.ob-splash-letter')).toHaveLength(9);
    expect(getByText('Office Panel · Smruti Ceramics')).toBeTruthy();
    expect(getByText('Connecting to Master Panel')).toBeTruthy();
    expect(getByText('v1.4.6')).toBeTruthy();
  });

  it('holds at least 5 s, waits on a slow boot, then plays Ready and hands over', () => {
    vi.useFakeTimers();
    try {
      const onDone = vi.fn();
      const { container } = render(<Splash {...props} ready onDone={onDone} />);
      act(() => void vi.advanceTimersByTime(SPLASH_MIN_MS - 1));
      expect(container.querySelector('.ob-splash--done')).toBeNull();
      act(() => void vi.advanceTimersByTime(1));
      expect(container.querySelector('.ob-splash--done')).not.toBeNull();
      expect(container.querySelector('.ob-splash-ready')?.textContent).toBe('Ready');
      act(() => void vi.advanceTimersByTime(SPLASH_FINISH_MS - 1));
      expect(onDone).not.toHaveBeenCalled();
      act(() => void vi.advanceTimersByTime(1));
      expect(onDone).toHaveBeenCalledTimes(1);
      expect(SPLASH_MIN_MS + SPLASH_FINISH_MS).toBeGreaterThanOrEqual(5000);

      // A boot still running at the hold's end keeps the splash waiting.
      cleanup();
      const late = vi.fn();
      const slow = render(<Splash {...props} ready={false} onDone={late} />);
      act(() => void vi.advanceTimersByTime(20_000));
      expect(slow.container.querySelector('.ob-splash--done')).toBeNull();
      expect(late).not.toHaveBeenCalled();
      slow.rerender(<Splash {...props} ready onDone={late} />);
      act(() => void vi.advanceTimersByTime(SPLASH_FINISH_MS));
      expect(late).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits at 90 % for the boot and fills the last 10 % only once it is done', () => {
    expect(css).toMatch(/@keyframes ob-sp-progress \{[\s\S]*?100% \{\s*transform: scaleX\(0\.9\);/);
    expect(css).toMatch(/\.ob-splash--done \.ob-splash-fill \{\s*animation: ob-sp-progress-end/);
  });
});

describe('reduced motion', () => {
  it('stands the busy mark and the splash still, under both switches', () => {
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    expect(reduced).toMatch(/\.ob-busy rect,\s*\.ob-splash \* \{\s*animation: none !important;/);
    expect(css).toMatch(/html\[data-motion='off'\] \.ob-busy rect,\s*html\[data-motion='off'\] \.ob-splash \* \{\s*animation: none !important;/);
    expect(reduced).toMatch(/\.ob-busy rect \{\s*opacity: 1;\s*transform: none;/);
    expect(css).toMatch(/html\[data-motion='off'\] \.ob-busy rect \{\s*opacity: 1;\s*transform: none;/);
  });
});
