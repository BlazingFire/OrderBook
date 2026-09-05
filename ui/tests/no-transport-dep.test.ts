/**
 * No hook may list `transport` in its dependency array.
 *
 * A screen in `ui/` takes a `transport` object from whichever panel mounted it.
 * Every call site is free to build that object inline — `master/web/src/App.tsx`
 * does, inside a `render:` callback that `ScreenHost` invokes on every one of
 * its own renders. So the object's *identity* changes constantly while its
 * *behaviour* never does. A hook that depends on the identity therefore re-runs
 * on every render: `AiSupportScreen` turned one status read into one settings
 * lookup per sync delta on the machine that owns the database, for as long as
 * the tab was open.
 *
 * This has now been fixed twice. The first fix left a prose postmortem in
 * `AssistantScreen.tsx`; an agent editing that very file two hundred lines away
 * wrote the bug again. So the rule is a test.
 *
 * The remedy is always the same: hold the prop in a ref, assign
 * `ref.current = transport` during render, read `ref.current` inside the hook,
 * and pass `[]`.
 *
 * ## Why this parses instead of matching
 *
 * The first version of this file used
 * `/useEffect\([^)]*\[([^\]]*)\]\s*\)/gs`. The `[^)]*` cannot cross the `)` in
 * `() => {`, which every real effect callback opens with, so it matched **zero**
 * of the call sites in this directory — including the exact code it was written
 * to catch. A guard that matches nothing is worse than no guard, because it
 * reads as coverage. Counting brackets is a dozen more lines and cannot be
 * wrong in that direction.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

/**
 * Every directory holding screens that take a transport.
 *
 * `master/web/src` and `office/web/src` are included deliberately: they hold
 * zero test files of their own, so this is the only thing looking at them.
 */
const SEARCH_DIRS = [
  path.join(REPO_ROOT, 'ui', 'src'),
  path.join(REPO_ROOT, 'master', 'web', 'src'),
  path.join(REPO_ROOT, 'office', 'web', 'src'),
];

/** The hooks whose last argument is a dependency array. */
const HOOKS = ['useEffect', 'useCallback', 'useMemo', 'useLayoutEffect', 'useImperativeHandle'];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * The text of every dependency array in `source`, with the line it starts on.
 *
 * Walks from each hook's opening paren counting brackets, so a `)` or a `]`
 * inside the callback body, a string or a nested call cannot end the scan
 * early. The dependency array is the last top-level `[...]` before the call's
 * closing paren.
 */
function dependencyArrays(source: string): Array<{ hook: string; deps: string; line: number }> {
  const found: Array<{ hook: string; deps: string; line: number }> = [];

  for (const hook of HOOKS) {
    const opener = new RegExp(`\\b${hook}\\s*\\(`, 'g');

    for (const match of source.matchAll(opener)) {
      const start = match.index + match[0].length;
      let depth = 1;
      let lastArrayStart = -1;
      let lastArrayEnd = -1;
      let squareDepth = 0;

      for (let i = start; i < source.length && depth > 0; i += 1) {
        const c = source[i];
        if (c === '(' || c === '{') depth += 1;
        else if (c === ')' || c === '}') depth -= 1;
        else if (c === '[') {
          depth += 1;
          if (squareDepth === 0 && depth === 2) lastArrayStart = i + 1;
          squareDepth += 1;
        } else if (c === ']') {
          depth -= 1;
          squareDepth -= 1;
          if (squareDepth === 0 && depth === 1 && lastArrayStart >= 0) lastArrayEnd = i;
        }
      }

      // `>=`, not `>`: an empty `[]` puts the end exactly at the start, and an
      // empty dependency list is a real finding to report as empty rather than
      // to drop.
      if (lastArrayStart >= 0 && lastArrayEnd >= lastArrayStart) {
        found.push({
          hook,
          deps: source.slice(lastArrayStart, lastArrayEnd),
          line: source.slice(0, lastArrayStart).split('\n').length,
        });
      }
    }
  }

  return found;
}

describe('the dependency-array scanner', () => {
  /*
   * The scanner is tested before it is trusted. The previous version of this
   * file shipped a regex that matched nothing, and nothing about a green run
   * said so — these three cases are what makes a green run mean something.
   */
  it('finds the dependency array past a callback body full of parentheses', () => {
    const sample = `useEffect(() => {
      void transport.status().then(setStatus).catch(() => setStatus(null));
    }, [transport]);`;

    expect(dependencyArrays(sample).map((entry) => entry.deps.trim())).toEqual(['transport']);
  });

  it('finds a multi-line dependency array', () => {
    const sample = `useCallback(async () => {
      await load();
    }, [
      transport,
      revision,
    ]);`;

    expect(dependencyArrays(sample)).toHaveLength(1);
    expect(dependencyArrays(sample)[0]!.deps).toContain('transport');
  });

  it('does not mistake an array literal inside the body for the dependency array', () => {
    const sample = `useEffect(() => {
      setRows([]);
    }, []);`;

    expect(dependencyArrays(sample).map((entry) => entry.deps.trim())).toEqual(['']);
  });
});

describe('no hook depends on transport identity', () => {
  it('lists transport in no dependency array anywhere a screen is defined', () => {
    const violations: string[] = [];

    for (const dir of SEARCH_DIRS) {
      for (const file of sourceFiles(dir)) {
        const text = readFileSync(file, 'utf8');
        const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');

        for (const { hook, deps, line } of dependencyArrays(text)) {
          // `transportRef` is the fix, not the bug, so match the bare word.
          if (/(^|[^\w.])transport\s*(,|$)/.test(deps.trim())) {
            violations.push(`${rel}:${line} — ${hook} depends on \`transport\``);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
