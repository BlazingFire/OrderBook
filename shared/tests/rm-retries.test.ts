// @vitest-environment node
/**
 * `vitest.setup.ts` gives recursive `fs.rm` retries, so a folder that something is still writing into for a
 * moment (the ENOTEMPTY of a Windows cleanup race) is removed instead of failing the test's cleanup.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/** Keeps adding files to `dir` until `stop()`: the removal sees the folder fill up behind it. */
function writeInto(dir: string): () => Promise<void> {
  let running = true;
  const loop = (async () => {
    for (let i = 0; running; i++) {
      await fs.writeFile(path.join(dir, `late-${i}.txt`), 'x').catch(() => undefined);
      await new Promise((resolve) => setImmediate(resolve));
    }
  })();
  return async () => {
    running = false;
    await loop;
  };
}

async function removeWhileWritten(): Promise<{ dir: string; error: unknown }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orderbook-rm-retries-'));
  await Promise.all(Array.from({ length: 200 }, (_, i) => fs.writeFile(path.join(dir, `f-${i}.txt`), 'x')));
  const stop = writeInto(dir);
  setTimeout(() => void stop(), 300);
  let error: unknown;
  await fs.rm(dir, { recursive: true, force: true }).catch((caught) => (error = caught));
  await stop();
  return { dir, error };
}

describe('recursive fs.rm in tests', () => {
  it('waits out a folder that is still being written into', async () => {
    const { dir, error } = await removeWhileWritten();
    expect(error).toBeUndefined();
    await expect(fs.stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

});
