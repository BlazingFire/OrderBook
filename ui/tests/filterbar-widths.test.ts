/**
 * A control that sits directly in the filter strip keeps its own width. `.ob-input` and
 * `.ob-select` are `width: 100%`; once the strip wraps (1.4.2) a bare one takes a whole row, so the
 * Activity log's two date fields stretched across the screen at 1024x768. jsdom has no layout, so this
 * pins the rules the layout depends on.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(process.cwd(), 'ui', 'src', 'base.css'), 'utf8');

/** The declarations of every rule whose selector list contains `selector` as one of its entries. */
function body(selector: string): string {
  const bodies: string[] = [];
  let from = 0;
  for (;;) {
    const open = css.indexOf('{', from);
    if (open < 0) break;
    const close = css.indexOf('}', open);
    const head = css.slice(css.lastIndexOf('}', open) + 1, open);
    const entries = head
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(',')
      .map((entry) => entry.trim());
    if (entries.includes(selector)) bodies.push(css.slice(open + 1, close));
    from = close + 1;
  }
  expect(bodies.length, `no rule for ${selector}`).toBeGreaterThan(0);
  return bodies.join('\n');
}

describe('controls in the filter strip', () => {
  it('the strip wraps, so a control must not ask for the whole line', () => {
    expect(body('.ob-filterbar')).toMatch(/flex-wrap:\s*wrap/);
  });

  it('a bare input or select is auto width, not 100%', () => {
    expect(body('.ob-filterbar > .ob-input')).toMatch(/width:\s*auto/);
    expect(body('.ob-filterbar > .ob-select')).toMatch(/width:\s*auto/);
  });

  it('a date input has a fixed natural width', () => {
    expect(body(".ob-filterbar > input[type='date'].ob-input")).toMatch(/width:\s*10\.7143rem/);
  });

  it('the base control rule is still full width (so forms are unchanged)', () => {
    expect(body('.ob-input')).toMatch(/width:\s*100%/);
  });
});
