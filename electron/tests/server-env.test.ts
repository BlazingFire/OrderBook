/**
 * Every variable a panel's desktop entrypoint hands its server is one that
 * server reads.
 *
 * The shell cannot import panel source, and the entrypoints call
 * `runPanelShell` at import (which needs Electron), so this reads both sides
 * as text. It exists because the Master's entrypoint set
 * `ORDERBOOK_MASTER_SETTINGS_FILE` for as long as there had been one, copied
 * from the Office's, and nothing in the Master ever read it — so the file it
 * named was never created, and the comment beside it described a pointer the
 * Master does not have.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The keys of the object `serverEnv` returns, in an entrypoint's source. */
function serverEnvKeys(entrypoint: string): string[] {
  const source = readFileSync(path.join(ROOT, 'electron', entrypoint), 'utf8');
  const body = /serverEnv:\s*\([^)]*\)\s*=>\s*\(\{([\s\S]*?)\n\s*\}\),/.exec(source)?.[1];
  if (!body) throw new Error(`No serverEnv object in electron/${entrypoint}`);
  return [...body.matchAll(/^\s*([A-Z][A-Z0-9_]*):/gm)].map((match) => match[1] as string);
}

/** Every TypeScript source under the folders a panel's server is built from. */
function sourceOf(...dirs: string[]): string {
  return dirs
    .flatMap((dir) =>
      readdirSync(path.join(ROOT, dir), { recursive: true, encoding: 'utf8' })
        .filter((file) => file.endsWith('.ts'))
        .map((file) => readFileSync(path.join(ROOT, dir, file), 'utf8')),
    )
    .join('\n');
}

describe.each([
  ['master.main.ts', ['master/src', 'shared/src']],
  ['office.main.ts', ['office/src', 'shared/src']],
] as const)('the variables electron/%s hands its server', (entrypoint, server) => {
  const keys = serverEnvKeys(entrypoint);
  const source = sourceOf(...server);

  it('names at least the data directory, so the parse above found the object', () => {
    expect(keys.some((key) => key.includes('DATA_DIR'))).toBe(true);
  });

  it('are each read somewhere in that server', () => {
    const unread = keys.filter((key) => !new RegExp(`\\b${key}\\b`).test(source));
    expect(unread).toEqual([]);
  });
});
