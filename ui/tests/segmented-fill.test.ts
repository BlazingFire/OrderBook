/**
 * The Print side control in the product lists (owner, 2026-11-18: "i want full
 * sizer full text ui buttons in product menu on every product").
 *
 * It was reading `De…` / `Def…` on every row. Two things had to change, and
 * neither is visible to jsdom, which has no layout:
 *
 *  1. `DataTable` gives every cell `display: flex`, so the `<span>` wrapping a
 *     cell's control is a **flex item** and is shrink-to-fit. It sized itself to
 *     the control's intrinsic width — about 105 px inside a 248 px cell — and the
 *     segmented control inside it got that. `.ob-cell-fill` sizes the wrapper
 *     from the cell instead.
 *  2. The segments themselves were `min-width: 0` + `text-overflow: ellipsis`,
 *     so anything too narrow cut the word. `min-width: max-content` keeps
 *     "Default" a word.
 *
 * So this pins the rules the layout depends on rather than a screenshot of it.
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

describe('a segmented control inside a table cell', () => {
  it('sizes the wrapper from the cell, not from the control it holds', () => {
    const rule = body('.ob-table tbody td > .ob-cell-fill');
    expect(rule).toMatch(/min-width:\s*100%/);
    // The generic `td > *` rule ellipses its child; this one must opt out, or
    // the wrapper clips the control that is meant to fill it.
    expect(rule).toMatch(/overflow:\s*visible/);
  });

  it("keeps a segment's label whole instead of cutting it to an ellipsis", () => {
    const rule = body('.ob-seg--fill > button');
    expect(rule).toMatch(/min-width:\s*max-content/);
    expect(rule).not.toMatch(/text-overflow/);
    expect(rule).not.toMatch(/overflow:\s*hidden/);
    // No `min-width: 0` — that is what let `flex: 1 1 0` shrink a segment below
    // its own text.
    expect(rule).not.toMatch(/min-width:\s*0/);
  });

  it("is the table's text size and fills the cell's own height", () => {
    expect(body('.ob-seg--fill > button')).toMatch(/font-size:\s*var\(--t-body-size\)/);
    expect(body('.ob-seg--fill > button')).toMatch(/padding:\s*0 var\(--s-12\)/);
    expect(body('.ob-seg--fill > button')).toMatch(/height:\s*100%/);
    expect(body('.ob-seg--fill')).toMatch(/height:\s*var\(--ctl-h-md\)/);
    expect(body('.ob-seg--fill')).toMatch(/width:\s*100%/);
  });
});

describe('the cells that hold a filling control', () => {
  // Both lists, and nothing else: a wrapper that stretches where the control
  // should not (a chip, a link) would break that column.
  const screens = {
    'Sub-products list (Master and Office)': join(
      process.cwd(),
      'ui',
      'src',
      'SubProductsScreen.tsx',
    ),
    'Sub-products list (Office catalogue)': join(
      process.cwd(),
      'office',
      'web',
      'src',
      'screens',
      'CatalogScreen.tsx',
    ),
  };

  it.each(Object.entries(screens))('%s uses the wrapper', (_name, file) => {
    const source = readFileSync(file, 'utf8');
    expect(source).toContain('className="ob-cell-fill"');
  });
});
