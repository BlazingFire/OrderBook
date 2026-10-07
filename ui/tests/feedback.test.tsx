/**
 * The feedback kit per the Feedback artboard (UI redesign): progress bars that fill by
 * scaleX, toasts (bottom-left, 4 s, at most 3, a failure as an
 * alert), the 400 ms tooltip that takes over `title`, and the reduced-motion rules.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SkeletonRows } from '../src/States.js';
import { ToastProvider, useToast } from '../src/Toast.js';
import { TOOLTIP_DELAY_MS, TooltipLayer } from '../src/Tooltip.js';
import { ProgressBar } from '../src/TopProgress.js';

const css = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'base.css'),
  'utf8',
).replace(/\r\n/g, '\n');

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ProgressBar', () => {
  it('moves the fill by scaleX only, never by width', () => {
    render(<ProgressBar value={0.64} label="Downloading update" detail="41.2 of 64.0 MB" />);
    const bar = screen.getByRole('progressbar', { name: 'Downloading update' });
    const fill = bar.firstElementChild as HTMLElement;
    expect(fill.style.transform).toBe('scaleX(0.64)');
    expect(fill.style.width).toBe('');
    expect(bar.getAttribute('aria-valuenow')).toBe('64');
    expect(screen.getByText('41.2 of 64.0 MB')).toBeTruthy();
  });

  it('says what state it is in by its tone, and sweeps while the size is unknown', () => {
    const { container } = render(<ProgressBar value={0.38} label="Import paused" tone="offline" />);
    expect(container.querySelector('.ob-progress--offline')).not.toBeNull();
    cleanup();
    render(<ProgressBar value={null} label="Taking backup snapshot" />);
    const bar = screen.getByRole('progressbar');
    expect(bar.hasAttribute('aria-valuenow')).toBe(false);
    expect(bar.querySelector('.ob-progress-fill--indeterminate')).not.toBeNull();
  });
});

// The busy mark's timing and its reduced-motion rules are D8's, pinned in mark.test.tsx.

describe('Skeleton', () => {
  it('is static: no shimmer anywhere in the kit', () => {
    const { container } = render(<SkeletonRows rows={3} columns={4} />);
    expect(container.querySelectorAll('.ob-skeleton-row')).toHaveLength(3);
    expect(css).not.toMatch(/@keyframes[^{]*shimmer/i);
    expect(css).not.toMatch(/\.ob-skeleton[^{]*\{[^}]*animation/);
  });
});

function Pusher({ messages }: { messages: Array<[string, 'ok' | 'error' | 'info']> }) {
  const toast = useToast();
  return (
    <button type="button" onClick={() => messages.forEach(([m, tone]) => toast.push(m, { tone }))}>
      push
    </button>
  );
}

describe('Toasts', () => {
  it('keeps at most three, says a failure as an alert, and goes after 4 s', () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Pusher
          messages={[
            ['one', 'ok'],
            ['two', 'info'],
            ['three', 'ok'],
            ["Couldn't print: no printer selected", 'error'],
          ]}
        />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'push' }));

    const toasts = document.querySelectorAll('.ob-toast');
    expect(toasts).toHaveLength(3);
    expect(screen.queryByText('one')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain("Couldn't print");
    expect(toasts[2]!.querySelector('.ob-toast-icon--error')).not.toBeNull();

    act(() => vi.advanceTimersByTime(3999));
    expect(document.querySelectorAll('.ob-toast')).toHaveLength(3);
    act(() => vi.advanceTimersByTime(1));
    expect(document.querySelectorAll('.ob-toast')).toHaveLength(0);
  });
});

describe('Toast placement', () => {
  // D5 note 1: at x = 16 the stack covered the sidebar's Collapse row for its 4 s.
  it('starts past the sidebar, expanded or collapsed, and at the window edge with no sidebar', () => {
    expect(css).toMatch(/\.ob-toasts \{[^}]*left: var\(--s-16\);/);
    expect(css).toMatch(
      /body:has\(\.ob-sidebar\) \.ob-toasts \{\s*left: calc\(var\(--shell-sidebar-w\) \+ var\(--s-16\)\);/,
    );
    expect(css).toMatch(
      /body:has\(\.ob-sidebar--collapsed\) \.ob-toasts \{\s*left: calc\(var\(--shell-sidebar-collapsed-w\) \+ var\(--s-16\)\);/,
    );
  });
});

describe('Tooltip', () => {
  it('shows the title after 400 ms in its own bubble, and gives the title back on leave', () => {
    vi.useFakeTimers();
    render(
      <>
        <TooltipLayer />
        <button type="button" title="Needs field.saleRate.view">
          <span>rate</span>
        </button>
      </>,
    );
    const button = screen.getByRole('button');
    const inner = screen.getByText('rate');

    fireEvent.pointerOver(inner);
    // Parked, so the browser's own tooltip does not show beside this one.
    expect(button.hasAttribute('title')).toBe(false);
    act(() => vi.advanceTimersByTime(TOOLTIP_DELAY_MS - 1));
    expect(screen.queryByRole('tooltip')).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole('tooltip').textContent).toBe('Needs field.saleRate.view');

    // Moving within the element keeps it.
    // jsdom has no PointerEvent, and a plain Event drops relatedTarget.
    inner.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: button }));
    fireEvent.pointerOver(button);
    expect(screen.getByRole('tooltip')).toBeTruthy();

    fireEvent.pointerOut(button, { relatedTarget: document.body });
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(button.getAttribute('title')).toBe('Needs field.saleRate.view');
  });

  // D10 note b: React removed the title while it was parked; giving it back would resurrect it.
  it('keeps a title React removed while it was parked removed, and takes a changed one', () => {
    vi.useFakeTimers();
    const Target = ({ title }: { title?: string }) => (
      <>
        <TooltipLayer />
        <button type="button" title={title}>
          go
        </button>
      </>
    );
    const { rerender } = render(<Target title="Old words" />);
    const button = screen.getByRole('button');

    fireEvent.pointerOver(button);
    rerender(<Target />);
    fireEvent.pointerDown(button);
    expect(button.hasAttribute('title')).toBe(false);

    rerender(<Target title="First" />);
    fireEvent.pointerOver(button);
    rerender(<Target title="Second" />);
    fireEvent.pointerDown(button);
    expect(button.getAttribute('title')).toBe('Second');
  });

  it('goes at once on a click or a key', () => {
    vi.useFakeTimers();
    render(
      <>
        <TooltipLayer />
        <button type="button" title="Refresh">
          R
        </button>
      </>,
    );
    const button = screen.getByRole('button');
    fireEvent.pointerOver(button);
    act(() => vi.advanceTimersByTime(TOOLTIP_DELAY_MS));
    expect(screen.getByRole('tooltip')).toBeTruthy();
    fireEvent.pointerDown(button);
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(button.getAttribute('title')).toBe('Refresh');
  });
});

describe('Motion', () => {
  it('stops the sweep and the toast slide under reduced motion', () => {
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.ob-topprogress-bar,\s*\.ob-progress-fill--indeterminate \{\s*animation: none/,
    );
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.ob-toast \{\s*animation: none/,
    );
  });
});
