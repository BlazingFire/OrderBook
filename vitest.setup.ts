/**
 * Test cleanup on Windows: `fs.rm(dir, { recursive: true })` can fail with ENOTEMPTY, EBUSY or EPERM while
 * antivirus, the search indexer or a just-closed handle still holds a file in the folder. Node retries those
 * errors when `maxRetries` is set, and no suite sets it (about 50 cleanups), so a loaded machine failed
 * a test for a cleanup race (`office/tests/sync-hold.test.ts`, ENOTEMPTY). Recursive removals here get
 * retries unless the caller chose its own.
 */

import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const retrying = <A extends unknown[], R>(remove: (path: fs.PathLike, options?: fs.RmOptions) => R) =>
  (path: fs.PathLike, options?: fs.RmOptions, ...rest: A): R =>
    remove(path, options?.recursive ? { maxRetries: 10, retryDelay: 100, ...options } : options, ...(rest as []));

fs.promises.rm = retrying(fs.promises.rm.bind(fs.promises)) as typeof fs.promises.rm;
fs.rmSync = retrying(fs.rmSync.bind(fs)) as typeof fs.rmSync;
// `import { rmSync } from 'node:fs'` reads the module's named exports, a copy made at load.
syncBuiltinESMExports();
