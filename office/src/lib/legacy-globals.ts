/**
 * The web globals this server uses, filled in where the runtime lacks them.
 *
 * The Windows 7 Office build runs this server on Electron 22, whose Node is
 * 16.17. That Node has no global `fetch`, `FormData`, `Headers`, `Request` or
 * `Response` (they arrived in Node 18), and no global `Blob` either, though
 * `node:buffer` has one. Every call to the Master goes through `fetch`, and
 * the upload proxy in `http/app.ts` builds a `FormData` around a `Blob`, so
 * without these the panel could neither pair nor sync.
 *
 * Only what is missing is installed, and undici is only loaded when something
 * is. On Node 20 and later every global is already there, so the normal build
 * never loads undici and behaves exactly as it did before.
 *
 * This module must be the first import in `index.ts`: ES modules run their
 * imports in order, so anything imported ahead of it would start up without
 * the globals.
 */

import { createRequire } from 'node:module';

// `require` rather than `import`, so the Node 20 path never loads undici at
// all. Top-level await would also work, but it would make every module that
// imports this one asynchronous.
const require = createRequire(import.meta.url);

const FROM_UNDICI = ['fetch', 'FormData', 'Headers', 'Request', 'Response'] as const;

/**
 * Installs each missing global on `target` and returns the names it installed.
 * `target` is a parameter so the test can pass a bare object.
 */
export function installLegacyGlobals(target: object = globalThis): string[] {
  const slots = target as Record<string, unknown>;
  const missing = (name: string): boolean => typeof slots[name] !== 'function';
  const installed: string[] = [];

  if (FROM_UNDICI.some(missing)) {
    const undici = require('undici') as Record<string, unknown>;
    for (const name of FROM_UNDICI) {
      if (!missing(name)) continue;
      slots[name] = undici[name];
      installed.push(name);
    }
  }

  if (missing('Blob')) {
    slots.Blob = (require('node:buffer') as { Blob: unknown }).Blob;
    installed.push('Blob');
  }

  return installed;
}

/**
 * A signal that aborts after `ms`, for the same Node 16 floor: the code that
 * runs on the Windows 7 build keeps off `AbortSignal.timeout` and
 * `AbortSignal.any`. The timer is unref'd so it never holds the process open.
 */
export function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms).unref();
  return controller.signal;
}

/*
 * What this module installed when it loaded, for `index.ts` to log. It does not
 * log here: the logger reads LOG_LEVEL once, when it first loads, and this module
 * loads before `config/index.ts` has read the .env files, so a logger loaded from
 * here would ignore a LOG_LEVEL set in one of them.
 */
export const installedLegacyGlobals = installLegacyGlobals();
