/**
 * The scale contract, enforced.
 *
 * The whole interface resizes from one number, `--root-size`, and that only
 * works while every length measured against text is expressed in rem. One
 * `height: 32px` added later does not break a build or fail a render — it just
 * quietly stops scaling, and nobody notices until an operator on a 4K screen
 * says a row looks wrong.
 *
 * Source-reading rather than rendering, in the style of
 * `party-access-screen-parity.test.ts` and `migration-registry.test.ts`: the
 * point is what is written in the files.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..');
const TOKENS = readFileSync(path.join(ROOT, 'ui', 'src', 'tokens.css'), 'utf8');

function declarations(css: string, name: RegExp): [string, string][] {
  return [...css.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gim)]
    .filter((match) => name.test(match[1] ?? ''))
    .map((match) => [match[1] ?? '', (match[2] ?? '').trim()]);
}

describe('scale tokens', () => {
  it('expresses every text-measured token in rem', () => {
    const offenders = declarations(
      TOKENS,
      /^--(s-\d+|shell-(topbar|filterbar|footer|sidebar)|row-h|ctl-h-)/,
    )
      .filter(([, value]) => /\d(px)\b/.test(value))
      .map(([name, value]) => `${name}: ${value}`);

    expect(offenders).toEqual([]);
  });

  it('keeps hairlines and radii in px', () => {
    // Scaling a 1px border to 1.14px renders blurry, and a radius is a visual
    // constant rather than a measurement against text.
    const shouldBePx = declarations(TOKENS, /^--(rail-w|r-(sm|md|lg))$/);
    expect(shouldBePx.length).toBeGreaterThan(0);
    expect(shouldBePx.filter(([, value]) => !value.endsWith('px'))).toEqual([]);
  });

  it('never lets a density preset set the root size', () => {
    /*
     * Density governs row and control heights; scale governs text. They were
     * one control, which is why there was no way to ask for small text with
     * roomy rows. A `--root-size` inside a `[data-density]` block would
     * silently re-merge them and make the slider fight the segmented control.
     */
    const blocks = [...TOKENS.matchAll(/\[data-density='[a-z]+'\]\s*\{([^}]*)\}/g)];
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.filter((block) => block[1]?.includes('--root-size'))).toEqual([]);
  });

  it('declares --root-size in px, since it is what rem resolves against', () => {
    const [root] = declarations(TOKENS, /^--root-size$/);
    expect(root?.[1]).toMatch(/^\d+(\.\d+)?px$/);
  });
});

describe('breakpoints', () => {
  it('are physical px, never rem or em', () => {
    /*
     * `em` in a media query resolves against the browser default, not
     * `html { font-size }`, so it cannot track the scale slider — and a
     * breakpoint that *did* track it would reorganise the layout mid-drag,
     * which reads as a bug.
     */
    const css = readFileSync(path.join(ROOT, 'ui', 'src', 'base.css'), 'utf8');
    const queries = [...css.matchAll(/@media\s*\(([^)]*)\)/g)].map((match) => match[1] ?? '');
    const sized = queries.filter((query) => /-(width|height):/.test(query));

    expect(sized.length).toBeGreaterThan(0);
    expect(sized.filter((query) => /\d\s*(rem|em)\b/.test(query))).toEqual([]);
  });
});

describe('JSX size literals', () => {
  /** Lengths that must scale; a raw number here is a px that will not. */
  const SIZE_PROPS = [
    'width',
    'height',
    'minWidth',
    'maxWidth',
    'minHeight',
    'maxHeight',
    'fontSize',
    'lineHeight',
  ];

  function sources(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...sources(full));
      else if (/\.tsx$/.test(entry)) out.push(full);
    }
    return out;
  }

  it('carries no hard-coded pixel size in a style object', () => {
    const pattern = new RegExp(
      `\\b(${SIZE_PROPS.join('|')})\\s*:\\s*(\\d+(?:\\.\\d+)?|'\\d+(?:\\.\\d+)?px')`,
      'g',
    );
    const offenders: string[] = [];

    for (const app of ['master/web/src', 'office/web/src', 'ui/src']) {
      for (const file of sources(path.join(ROOT, app))) {
        // `icons.tsx` keeps numeric width/height as SVG *attributes* — rem is
        // not a legal SVG 1.1 attribute unit — and sets the rem size in CSS
        // alongside them.
        if (file.endsWith('icons.tsx')) continue;

        const text = readFileSync(file, 'utf8');
        for (const match of text.matchAll(pattern)) {
          const px = Number((match[2] ?? '').replace(/['px]/g, ''));

          /*
           * Three exemptions, and they are the same rule the CSS follows:
           *  · `0` is unitless and has no size to scale;
           *  · 1-3px are hairlines and nudges — scaling a 1px rule to 1.14px
           *    just renders blurry;
           *  · anything else measured against text must be `rem()`.
           */
          if (px <= 3) continue;

          offenders.push(`${path.relative(ROOT, file)}: ${match[0]}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

/**
 * The standing rule the owner set, written down where a change trips over it:
 * **an Open on a table row shows the record's detail on a screen of its own**,
 * with one way back in a fixed place and its entry nested under its module in
 * the sidebar. Not a right-hand drawer, and not a row that expands inline —
 * both were tried and turned down — and, since 2026-09-08, not a centred modal
 * either. Modals remain right for dialogs: a create/edit form, an import
 * wizard, a confirmation. They are not right for reading a record.
 *
 * This matters beyond taste: `fitColumns` drops columns on a narrow screen, and
 * that is only defensible because the whole record is one click away.
 */
describe('record detail opens on its own screen', () => {
  function screenFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...screenFiles(full));
      else if (/\.tsx$/.test(entry)) out.push(full);
    }
    return out;
  }

  it('has no Drawer left to open', () => {
    // The component is gone, not merely unused: the two form drawers were the
    // last holdouts and they are modals now. A `<Drawer>` anywhere would not
    // compile, and this catches the resurrection before somebody writes one.
    expect(existsSync(path.join(ROOT, 'ui', 'src', 'Drawer.tsx'))).toBe(false);

    const offenders: string[] = [];

    for (const app of ['master/web/src', 'office/web/src', 'ui/src']) {
      for (const file of screenFiles(path.join(ROOT, app))) {
        if (readFileSync(file, 'utf8').includes('<Drawer')) {
          offenders.push(path.relative(ROOT, file));
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('only lets a column be dropped on a table whose rows open', () => {
    const offenders: string[] = [];

    for (const app of ['master/web/src/screens', 'office/web/src/screens']) {
      for (const file of screenFiles(path.join(ROOT, app))) {
        const text = readFileSync(file, 'utf8');
        // A file that tags priorities must also open its rows. Per-file rather
        // than per-table: a screen with several tables would need a parser to
        // pair them, and a screen that opens no row at all is the case worth
        // catching.
        if (/^\s*priority: [23],$/m.test(text) && !text.includes('onRowOpen')) {
          offenders.push(path.relative(ROOT, file));
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
