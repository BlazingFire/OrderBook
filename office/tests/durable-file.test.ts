/**
 * `writeDurable`, the write behind everything an Office cannot get back from the
 * Master: the old file survives a failed write, a moment's lock is not a failure,
 * and overlapping writes cannot trip over their shared temp name.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { writeDurable } from '../src/lib/durable-file.js';

describe('writeDurable', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ob-durable-'));
    file = path.join(dir, 'nested', 'outbox.json');
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('writes the file, its folder included, and leaves no temp file', async () => {
    await writeDurable(file, 'one');
    expect(await fs.readFile(file, 'utf8')).toBe('one');
    expect(await fs.readdir(path.dirname(file))).toEqual(['outbox.json']);
  });

  it('flushes to the disk before the rename: that is what survives a power cut', async () => {
    const order: string[] = [];
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      const realSync = handle.sync.bind(handle);
      handle.sync = async () => {
        order.push('sync');
        await realSync();
      };
      return handle;
    });
    const realRename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      order.push('rename');
      await realRename(from, to);
    });

    await writeDurable(file, 'one');

    expect(order).toEqual(['sync', 'rename']);
  });

  it('keeps the last good contents when a write fails', async () => {
    await writeDurable(file, 'good');
    vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(new Error('ENOSPC'));

    await expect(writeDurable(file, 'bad')).rejects.toThrow('ENOSPC');

    expect(await fs.readFile(file, 'utf8')).toBe('good');
  });

  it('rides out a moment of an antivirus scan holding the file', async () => {
    const locked = Object.assign(new Error('EPERM'), { code: 'EPERM' });
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(locked).mockRejectedValueOnce(locked);

    await writeDurable(file, 'one');

    expect(await fs.readFile(file, 'utf8')).toBe('one');
  });

  it('runs overlapping writes in order, and a failure does not stop the next', async () => {
    const writes = [writeDurable(file, 'one'), writeDurable(file, 'two'), writeDurable(file, 'three')];
    await Promise.all(writes);
    expect(await fs.readFile(file, 'utf8')).toBe('three');

    vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(new Error('ENOSPC'));
    const failing = writeDurable(file, 'lost');
    const after = writeDurable(file, 'four');
    await expect(failing).rejects.toThrow('ENOSPC');
    await after;
    expect(await fs.readFile(file, 'utf8')).toBe('four');
  });
});
