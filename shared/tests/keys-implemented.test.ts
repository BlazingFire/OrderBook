/**
 * Every command in the catalogue must be reachable, and the evidence must come
 * from the source rather than from a list kept beside it.
 *
 * A command that exists in `COMMANDS` but is handled nowhere is worse than a
 * missing feature: the palette offers it, the help sheet prints its chord, and
 * pressing that chord does nothing — while `preventDefault` may already have
 * taken the key away from the browser. `d52bdef` shipped four of them.
 *
 * ## Why this does not keep an allowlist
 *
 * The first version of this file did. `SHELL_DISPATCHED` listed every id in the
 * catalogue — including `edit.undo`, `edit.duplicate`, `nav.prev` and `nav.next`,
 * the exact four dead commands it was written to catch — and seeded the
 * "implemented" set from it before looking at any source. It could not fail.
 * Its `KeyboardProvider.tsx` branch made that worse by adding *every* string
 * literal in that file to the set.
 *
 * So there is no allowlist here. Each of the four ways a command can be handled
 * is looked for where that handling actually lives:
 *
 *   1. `command.tab` is set          -> the provider routes it via `onNavigate`
 *   2. `useCommand('<id>')`          -> a screen registered a handler
 *   3. `command.id === '<id>'`       -> the provider's own keydown switch
 *   4. a key in `shellCommands={{}}` -> a panel's App.tsx passed a callback
 *
 * Cases 3 and 4 read narrowly on purpose: case 3 requires the comparison form
 * the switch is written in, not a bare mention of the string, and case 4 only
 * looks inside the `shellCommands` object literal.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { COMMANDS } from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const SEARCH_DIRS = [
  path.join(REPO_ROOT, 'ui', 'src'),
  path.join(REPO_ROOT, 'master', 'web', 'src'),
  path.join(REPO_ROOT, 'office', 'web', 'src'),
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** The body of every `shellCommands={{ ... }}` prop, so its keys can be read. */
function shellCommandBlocks(source: string): string[] {
  const blocks: string[] = [];
  const opener = /shellCommands=\{\{/g;

  for (const match of source.matchAll(opener)) {
    const start = match.index + match[0].length;
    let depth = 2;
    for (let i = start; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          blocks.push(source.slice(start, i));
          break;
        }
      }
    }
  }

  return blocks;
}

const registered = new Set<string>();
const switched = new Set<string>();
const shelled = new Set<string>();

for (const dir of SEARCH_DIRS) {
  for (const file of sourceFiles(dir)) {
    const text = readFileSync(file, 'utf8');

    for (const match of text.matchAll(/useCommand\(\s*['"]([A-Za-z0-9_.]+)['"]/g)) {
      registered.add(match[1]!);
    }

    // The provider's switch compares the id; a bare mention is not a handler.
    for (const match of text.matchAll(/command\.id\s*===\s*['"]([A-Za-z0-9_.]+)['"]/g)) {
      switched.add(match[1]!);
    }

    for (const block of shellCommandBlocks(text)) {
      for (const match of block.matchAll(/['"]([A-Za-z0-9_.]+)['"]\s*:/g)) {
        shelled.add(match[1]!);
      }
    }
  }
}

function handledBy(id: string, tab: string | undefined): string | null {
  if (tab) return 'nav';
  if (registered.has(id)) return 'useCommand';
  if (switched.has(id)) return 'provider switch';
  if (shelled.has(id)) return 'shellCommands';
  return null;
}

describe('every command in the catalogue is handled somewhere', () => {
  it('finds a handler for each COMMANDS entry', () => {
    const dead = COMMANDS.filter((command) => !handledBy(command.id, command.tab)).map(
      (command) => command.id,
    );

    expect(dead).toEqual([]);
  });

  /*
   * The scanners are checked before they are trusted — this is the half the
   * previous version had no equivalent of, and the reason it passed against
   * four dead commands.
   */
  it('does not count a bare string literal as a handler', () => {
    expect(handledBy('definitely.not.a.command', undefined)).toBeNull();
  });

  it('reads the keys out of a shellCommands literal', () => {
    const sample = `<KeyboardProvider shellCommands={{ 'view.reset': reset, 'x.y': () => {} }}>`;
    const keys = shellCommandBlocks(sample).flatMap((block) =>
      [...block.matchAll(/['"]([A-Za-z0-9_.]+)['"]\s*:/g)].map((m) => m[1]!),
    );

    expect(keys).toEqual(['view.reset', 'x.y']);
  });

  it('actually located the real handlers, so an empty scan cannot pass as success', () => {
    // If a refactor moves the provider switch or the shellCommands props, these
    // go empty and every command would look "dead" — which is the failure this
    // file should report loudly rather than quietly inverting into a pass.
    expect(switched.size).toBeGreaterThan(0);
    expect(shelled.size).toBeGreaterThan(0);
    expect(registered.size).toBeGreaterThan(0);
  });
});
