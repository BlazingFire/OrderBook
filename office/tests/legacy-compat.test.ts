/**
 * The Office server's Node 16 floor, for the Windows 7 build.
 *
 * That build runs this server on Electron 22, whose Node is 16.17. Vitest
 * cannot run on Node 16, so these checks run on the current Node: they read
 * the source for APIs Node 16 lacks, and they drive the two places that fill
 * a gap (`legacy-globals.ts` and the disk-space fallback in `paths.ts`) as if
 * the gap were there. The real Node 16 run is `npm run smoke:legacy`.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installLegacyGlobals } from '../src/lib/legacy-globals.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

/** Source with its comments blanked, so a comment naming an API is not a use of it. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** What Node 16.17 does not have, and what to use instead. */
const NODE16_MISSING: Array<[RegExp, string]> = [
  [
    /import\s*\{[^}]*\b(statfs|statfsSync|openAsBlob|glob|globSync|cp|cpSync)\b[^}]*\}\s*from\s*'(node:)?fs(\/promises)?'/,
    'a named fs import Node 16 lacks; feature-detect it on the module',
  ],
  [/\bReadable\.(fromWeb|toWeb)\b/, 'Readable.from'],
  [/\bcloseAllConnections\b|\bcloseIdleConnections\b/, 'tracked sockets'],
  [/\bAbortSignal\.(any|timeout)\b/, 'timeoutSignal from lib/legacy-globals.ts'],
  [/\bstructuredClone\(/, 'a JSON copy'],
  [/\bimport\.meta\.(dirname|filename)\b/, 'fileURLToPath(import.meta.url)'],
  [/\.(findLast|findLastIndex|toSorted|toReversed|toSpliced)\(/, 'an ES2022 equivalent'],
  [/\bObject\.groupBy\b|\bPromise\.withResolvers\b|\bArray\.fromAsync\b/, 'an ES2022 equivalent'],
  [
    /\bos\.availableParallelism\b|\butil\.styleText\b|\bprocess\.loadEnvFile\b/,
    'an API Node 16 has',
  ],
];

describe('office/src and shared/src keep to Node 16.17', () => {
  const files = [
    ...sourceFiles(path.join(ROOT, 'office/src')),
    ...sourceFiles(path.join(ROOT, 'shared/src')),
  ];

  it.each(NODE16_MISSING)('nothing uses %s', (pattern, instead) => {
    const offenders = files.filter((file) => pattern.test(code(file)));
    expect(
      offenders.map((file) => path.relative(ROOT, file)),
      `use ${instead} instead`,
    ).toEqual([]);
  });

  it('installs the legacy globals before anything else in the entry point', () => {
    const entry = code(path.join(ROOT, 'office/src/index.ts'));
    const firstImport = /^import\s[^;]*;/m.exec(entry)?.[0];
    expect(firstImport).toMatch(/from '\.\/lib\/legacy-globals\.js';$/);
  });

  // The logger fixes LOG_LEVEL when it first loads, and legacy-globals loads
  // before config/index.ts has read the .env files. Importing anything from
  // here would load it too early, so a LOG_LEVEL in a .env would be ignored.
  it('loads nothing of its own ahead of the config', () => {
    const shim = code(path.join(ROOT, 'office/src/lib/legacy-globals.ts'));
    const imports = [...shim.matchAll(/^import\s[^;]*?from\s+'([^']+)';/gm)].map((m) => m[1] ?? '');
    expect(imports.filter((spec) => !spec.startsWith('node:'))).toEqual([]);
  });

  // undici 6 and later need Node 18. `npm audit fix` offers the bump for its
  // open advisories; docs/WINDOWS7.md records why the pin stays.
  it('pins undici to the 5.x line, the last that runs on Node 16', () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'office/package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.undici).toMatch(/^5\.\d+\.\d+$/);
  });
});

describe('installLegacyGlobals', () => {
  it('fills every missing global with a working implementation', () => {
    const target: Record<string, unknown> = {};

    const installed = installLegacyGlobals(target);

    expect(installed.sort()).toEqual(
      ['Blob', 'FormData', 'Headers', 'Request', 'Response', 'fetch'].sort(),
    );
    for (const name of installed) expect(typeof target[name]).toBe('function');

    // The upload proxy's shape: a FormData around a Blob, with a filename.
    const FormDataImpl = target.FormData as typeof FormData;
    const BlobImpl = target.Blob as typeof Blob;
    const form = new FormDataImpl();
    form.append('file', new BlobImpl([Buffer.from('a,b\n')]), 'products.csv');
    expect((form.get('file') as File).name).toBe('products.csv');
  });

  it('leaves a global that is already there alone', () => {
    const fetch = (): void => {};
    const target: Record<string, unknown> = { fetch };

    const installed = installLegacyGlobals(target);

    expect(target.fetch).toBe(fetch);
    expect(installed).not.toContain('fetch');
  });

  it('installs nothing on a Node that has them all', () => {
    expect(installLegacyGlobals(globalThis)).toEqual([]);
  });
});

describe('disk space', () => {
  afterEach(() => {
    vi.doUnmock('node:fs');
    vi.doUnmock('node:child_process');
    vi.resetModules();
  });

  async function loadPaths() {
    vi.resetModules();
    vi.doMock('../src/config/index.js', () => ({ config: { dataDir: ROOT } }));
    return import('../src/config/paths.js');
  }

  it('reads wmic output', async () => {
    const { parseWmicDisk } = await loadPaths();

    expect(parseWmicDisk('\r\r\nFreeSpace=123\r\r\nSize=456\r\r\n\r\r\n')).toEqual({
      free: 123,
      total: 456,
    });
    expect(parseWmicDisk('No Instance(s) Available.')).toBeNull();
    expect(parseWmicDisk('FreeSpace=\r\nSize=456')).toBeNull();
  });

  it('answers from fs.statfs where Node has it', async () => {
    const { diskSpace, freeDiskBytes } = await loadPaths();

    expect(typeof (await freeDiskBytes(ROOT))).toBe('number');
    expect(typeof (await diskSpace(ROOT))?.total).toBe('number');
  });

  it('falls back to wmic on Windows, and to null elsewhere, when fs.statfs is missing', async () => {
    vi.doMock('node:fs', async (original) => {
      const real = await original<{ default: object }>();
      return { ...real, default: { ...real.default, statfs: undefined } };
    });
    const execFile = Object.assign(vi.fn(), {
      [promisify.custom]: vi.fn(async () => ({ stdout: 'FreeSpace=1000\r\nSize=5000\r\n' })),
    });
    vi.doMock('node:child_process', () => ({ execFile }));

    const { diskSpace, freeDiskBytes } = await loadPaths();

    if (process.platform === 'win32') {
      // Both figures come from one wmic run.
      expect(await diskSpace('C:\\OrderBook')).toEqual({ free: 1000, total: 5000 });
      expect(execFile[promisify.custom]).toHaveBeenCalledTimes(1);
      expect(await freeDiskBytes('C:\\OrderBook')).toBe(1000);
      expect(execFile[promisify.custom]).toHaveBeenCalledWith(
        'wmic',
        ['logicaldisk', 'where', "DeviceID='C:'", 'get', 'FreeSpace,Size', '/value'],
        expect.anything(),
      );
      // A network share has no drive letter to ask about.
      expect(await freeDiskBytes('\\\\server\\share\\OrderBook')).toBeNull();
    } else {
      expect(await freeDiskBytes('/tmp')).toBeNull();
      expect(execFile[promisify.custom]).not.toHaveBeenCalled();
    }
  });
});
