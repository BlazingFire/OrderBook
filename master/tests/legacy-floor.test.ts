/**
 * The runtime floors stay where docs/WINDOWS7.md puts them.
 *
 * The Windows 7 Office build runs on Electron 22: Node 16.17 for the Office
 * server, the shared package and the shell, and Chromium 108 for the web UI
 * (the Master UI too, since a Win7 PC opens it in Chrome 109). Vitest cannot
 * run on Node 16, and nothing here can launch Chromium 108, so a newer API
 * passes every other test and fails only on the customer's PC. These are the
 * static locks; `npm run smoke:legacy` is the runtime one.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { ESLint } from 'eslint';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..');

function compilerOptions(file: string): Record<string, unknown> {
  const { config, error } = ts.readConfigFile(path.join(ROOT, file), ts.sys.readFile);
  if (error)
    throw new Error(`${file}: ${ts.flattenDiagnosticMessageText(error.messageText, '\n')}`);
  return {
    ...(config.compilerOptions ?? {}),
    extends: config.extends,
    include: config.include,
    exclude: config.exclude,
  };
}

function cssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...cssFiles(full));
    else if (entry.endsWith('.css')) out.push(full);
  }
  return out;
}

describe('TypeScript lib', () => {
  // ES2023+ builtins (findLast, toSorted, Object.groupBy, Promise.withResolvers)
  // are type errors only while every lib stops at ES2022.
  it('stops at ES2022 for the Node code', () => {
    const base = compilerOptions('tsconfig.base.json');
    expect(base.lib).toEqual(['ES2022']);
    expect(base.target).toBe('ES2022');
    for (const file of ['shared/tsconfig.json', 'office/tsconfig.json', 'electron/tsconfig.json']) {
      const options = compilerOptions(file);
      expect(options.lib, `${file} overrides lib`).toBeUndefined();
      expect(options.target, `${file} overrides target`).toBeUndefined();
    }
  });

  it('stops at ES2022 + DOM for the web code', () => {
    for (const file of [
      'ui/tsconfig.json',
      'master/web/tsconfig.json',
      'office/web/tsconfig.json',
    ]) {
      const options = compilerOptions(file);
      expect(options.lib, file).toEqual(['ES2022', 'DOM', 'DOM.Iterable']);
      expect(options.target, file).toBe('ES2022');
    }
  });
});

describe('web build target', () => {
  /** Every browser the file's `target:` names, as [name, major]. */
  function targets(file: string): [string, number][] {
    const value = /\btarget:\s*(\[[^\]]*\]|'[^']*')/.exec(
      readFileSync(path.join(ROOT, file), 'utf8'),
    )?.[1];
    return [...(value ?? '').matchAll(/'([a-z]+)(\d+)'/g)].map(([, name, major]) => [
      name!,
      Number(major),
    ]);
  }

  // The Office UI only ever runs in Electron, so Chromium 108 is its whole list.
  it('office/web/vite.config.ts builds for chrome108', () => {
    expect(targets('office/web/vite.config.ts')).toEqual([['chrome', 108]]);
  });

  // Any browser on the LAN may open the Master UI, so Chromium 108 joins
  // Vite's default list rather than replacing it, and no Chrome above it is named.
  it('master/web/vite.config.ts names chrome108 and nothing above it', () => {
    const list = targets('master/web/vite.config.ts');
    expect(list).toContainEqual(['chrome', 108]);
    expect(list.filter(([name, major]) => name === 'chrome' && major > 108)).toEqual([]);
  });
});

describe('CSS', () => {
  // What arrived after Chromium 108. Comments are stripped first, so prose
  // may still name them.
  const BANNED: [string, RegExp][] = [
    ['color-mix()', /\bcolor-mix\(/],
    ['oklch()', /\boklch\(/],
    ['oklab()', /\boklab\(/],
    ['light-dark()', /\blight-dark\(/],
    ['text-wrap', /\btext-wrap\b/],
    ['@scope', /@scope\b/],
    ['@starting-style', /@starting-style\b/],
    ['subgrid', /\bsubgrid\b/],
    ['field-sizing', /\bfield-sizing\b/],
    ['anchor-name', /\banchor-name\b/],
    ['position-anchor', /\bposition-anchor\b/],
    ['interpolate-size', /\binterpolate-size\b/],
    ['calc-size()', /\bcalc-size\(/],
    ['transition-behavior', /\btransition-behavior\b/],
    ['view-transition', /\bview-transition/],
    [':user-valid / :user-invalid', /:user-(in)?valid\b/],
    [':dir()', /:dir\(/],
    [':popover-open', /:popover-open\b/],
    ['relative colour syntax', /\(\s*from\s/],
    ['round() / mod() / rem()', /(^|[^-\w])(round|mod|rem)\(/],
    ['lh / rlh units', /\d(r?lh)\b/],
    ['unprefixed mask', /(^|[^-\w])mask(-image)?\s*:/],
    ['nesting', /(^|\s)&[\s.:[>+~]/m],
  ];

  const files = ['ui/src', 'master/web/src', 'office/web/src'].flatMap((dir) =>
    cssFiles(path.join(ROOT, dir)),
  );

  it('finds the stylesheets', () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  it.each(files.map((file) => [path.relative(ROOT, file), file]))(
    '%s stays within Chromium 108',
    (_name, file) => {
      const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      const found = BANNED.filter(([, pattern]) => pattern.test(css)).map(([name]) => name);
      expect(found).toEqual([]);
    },
  );
});

describe('electron/tsconfig.legacy.json', () => {
  it('compiles the shell files the Win7 build runs to CommonJS', () => {
    const options = compilerOptions('electron/tsconfig.legacy.json');
    expect(String(options.module).toLowerCase()).toBe('commonjs');
    expect(options.include).toEqual(
      expect.arrayContaining(['shell.ts', 'office.main.ts', 'preload.cts', 'lib/*.ts']),
    );
    expect((options.exclude as string[]).some((entry) => entry.startsWith('lib/cleaner'))).toBe(
      true,
    );
  });
});

describe('eslint floor blocks', () => {
  const eslint = new ESLint({ cwd: ROOT });

  async function rulesHit(filePath: string, code: string): Promise<string[]> {
    const [result] = await eslint.lintText(code, { filePath: path.join(ROOT, filePath) });
    return result!.messages.map((m) => m.ruleId ?? m.message);
  }

  // One case per path the floors cover, each using something above its floor.
  const HELD: [string, string, string][] = [
    ['office/src/x.ts', 'export const c = structuredClone({});', 'no-restricted-globals'],
    [
      'office/src/x.ts',
      "import { statfs } from 'node:fs';\nexport { statfs };",
      'no-restricted-imports',
    ],
    [
      'office/src/x.ts',
      "import { cpSync } from 'fs';\nexport { cpSync };",
      'no-restricted-imports',
    ],
    [
      'office/src/x.ts',
      "import { cp } from 'node:fs/promises';\nexport { cp };",
      'no-restricted-imports',
    ],
    [
      'office/src/x.ts',
      "import { Readable } from 'node:stream';\nexport const r = Readable.fromWeb;",
      'no-restricted-properties',
    ],
    ['office/src/x.ts', 'export const d = import.meta.dirname;', 'no-restricted-syntax'],
    [
      'shared/src/x.ts',
      'export const g = Object.groupBy([1], () => 1);',
      'no-restricted-properties',
    ],
    ['shared/src/x.ts', 'export const c = structuredClone({});', 'no-restricted-globals'],
    ['ui/src/x.ts', 'export const s = AbortSignal.any([]);', 'no-restricted-properties'],
    ['ui/src/x.tsx', 'export const e = <div popover="auto" />;', 'no-restricted-syntax'],
    ['master/web/src/x.ts', 'export const id = crypto.randomUUID();', 'no-restricted-properties'],
    ['office/web/src/x.ts', 'export const s = AbortSignal.any([]);', 'no-restricted-properties'],
    ['electron/shell.ts', "export const r = fetch('http://127.0.0.1');", 'no-restricted-globals'],
    ['electron/shell.ts', 'export const u = import.meta.url;', 'no-restricted-syntax'],
    ['electron/lib/x.ts', 'export const c = structuredClone({});', 'no-restricted-globals'],
  ];

  it.each(HELD)(
    '%s: %s',
    async (file, code, rule) => {
      expect(await rulesHit(file, code)).toContain(rule);
    },
    30_000,
  );

  // The Master server and the Electron 33-only shell entries run on Node 22.
  it.each([
    ['master/src/x.ts', 'export const c = structuredClone({});'],
    ['electron/master.main.ts', "export const r = fetch('http://127.0.0.1');"],
  ])(
    '%s is not held to a floor',
    async (file, code) => {
      expect(await rulesHit(file, code)).toEqual([]);
    },
    30_000,
  );
});
