/**
 * The topbar's priorities (found at 157 % on a 1024 px screen, on every screen): the
 * title was squeezed to 0-28 px, and "New pending order" and "Change password"
 * overflowed their boxes and drew over what stood beside them. jsdom has no layout,
 * so this pins what the layout depends on: the rules in `base.css`, the title's
 * tooltip, and that a squeezable button keeps its label in a span.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { TopbarTitle, type NavGroup } from '../src/AppShell.js';

afterEach(cleanup);

const root = process.cwd();
const css = readFileSync(join(root, 'ui', 'src', 'base.css'), 'utf8');

/** The declarations of every rule whose selector is exactly `selector`, joined. */
function body(selector: string): string {
  const escaped = selector.split('.').join('\\.').split('(').join('\\(').split(')').join('\\)').split('>').join('\\>');
  const found = [...css.matchAll(new RegExp(String.raw`(?:^|[}/])\s*` + escaped + String.raw`\s*\{([^}]*)\}`, 'g'))];
  expect(found.length, `no rule for ${selector}`).toBeGreaterThan(0);
  return found.map((match) => match[1] ?? '').join(';');
}

describe('the topbar title', () => {
  const groups: NavGroup[] = [
    { label: 'Catalogue', items: [{ id: 'parties', label: 'A very long page name for the topbar', icon: 'parties' }] },
  ];

  it('offers its full name as a tooltip only while it is cut, and does not name itself otherwise', () => {
    render(<TopbarTitle groups={groups} activeId="parties" fallback="x" />);
    const heading = screen.getByRole('heading', { level: 1 });
    // No standing title: it would also answer every lookup of a sidebar row by title.
    expect(heading.getAttribute('title')).toBeNull();

    Object.defineProperty(heading, 'scrollWidth', { configurable: true, value: 300 });
    Object.defineProperty(heading, 'clientWidth', { configurable: true, value: 100 });
    fireEvent.mouseEnter(heading);
    expect(heading.getAttribute('title')).toBe('A very long page name for the topbar');

    Object.defineProperty(heading, 'scrollWidth', { configurable: true, value: 100 });
    fireEvent.mouseEnter(heading);
    expect(heading.getAttribute('title')).toBe('');
  });
});

describe('the topbar rules', () => {
  it('keep an action whole and let only the buttons with a span label give way, down to a floor', () => {
    expect(body('.ob-topbar .ob-btn')).toMatch(/flex:\s*none/);
    const gives = body('.ob-topbar .ob-btn:has(> span)');
    expect(gives).toMatch(/flex:\s*0 1 auto/);
    expect(gives).toMatch(/min-width:\s*[1-9]/);
  });

  it('keep the icon buttons from shrinking to nothing', () => {
    expect(css).toMatch(/\.ob-topbar \.ob-icon-btn,\s*\.ob-topbar \.ob-bell\s*\{[^}]*flex:\s*none/);
  });

  it('give the title a floor of its own', () => {
    expect(body('.ob-topbar-title')).toMatch(/min-width:\s*[1-9]/);
  });

  it('drop the eyebrow and tighten the bar when the main column is narrow', () => {
    expect(body('.ob-main')).toMatch(/container-type:\s*inline-size/);
    expect(css).toMatch(/@container ob-main \(max-width:\s*\d+rem\)\s*\{[\s\S]*\.ob-topbar-eyebrow\s*\{\s*display:\s*none/);
    expect(css).toMatch(/@container ob-main[\s\S]*\.ob-topbar\s*\{[^}]*column-gap/);
  });

  it('turn the command box and Change password into icons when the bar is narrower still (157 % at 1366)', () => {
    // Wide: the icon is hidden, the label shows.
    expect(body('.ob-btn--squeeze > svg')).toMatch(/display:\s*none/);
    const narrow = /@container ob-main \(max-width:\s*(\d+)rem\)\s*\{(?:(?!@container)[\s\S])*?\.ob-btn--squeeze > span\s*\{\s*display:\s*none/.exec(css);
    expect(narrow, 'no narrow rule hiding the squeeze labels').not.toBeNull();
    // Below 1080p at 150 % (about 75rem) and above 157 % at 1366 (about 47rem).
    expect(Number(narrow![1])).toBeGreaterThan(47);
    expect(Number(narrow![1])).toBeLessThan(75);
  });
});

describe('the Master topbar', () => {
  it('keeps the Change password label in a span, so it can end in an ellipsis', () => {
    const app = readFileSync(join(root, 'master', 'web', 'src', 'App.tsx'), 'utf8');
    expect(app).toMatch(/<span>\{t\('action\.changePassword'\)\}<\/span>/);
    // Squeezable, with an icon and an accessible name for when the label is hidden.
    expect(app).toMatch(/ob-btn--squeeze"[\s\S]{0,200}aria-label=\{t\('action\.changePassword'\)\}[\s\S]{0,120}<Icon name="key"/);
  });
});
