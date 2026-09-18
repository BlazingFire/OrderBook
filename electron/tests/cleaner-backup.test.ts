/**
 * The copy taken before everything goes.
 *
 * `runBackup` touches the filesystem, so it is exercised against a real temp
 * tree rather than mocked — a backup that is asserted rather than performed is
 * the kind that turns out to be empty on the day it is needed.
 */

import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { isSafeDestination, planBackup, runBackup } from '../lib/cleaner/backup.js';

const made: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ob-cleaner-'));
  made.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('planning where each folder lands', () => {
  it('puts each one in its own named folder, never in the chosen folder itself', () => {
    expect(planBackup(['/a/master', '/a/office'], '/backup')).toEqual([
      { from: '/a/master', to: path.join('/backup', 'master') },
      { from: '/a/office', to: path.join('/backup', 'office') },
    ]);
  });

  it('does not let two folders with the same name merge into one', () => {
    // A relocated data folder can be called anything, including the same thing
    // as another panel's. Merging them would look like a successful backup and
    // silently lose one of the two.
    const plans = planBackup(['/a/data', '/b/data', '/c/data'], '/backup');
    expect(plans.map((plan) => path.basename(plan.to))).toEqual(['data', 'data-2', 'data-3']);
  });
});

describe('copying', () => {
  it('copies the tree, contents and all', async () => {
    const source = await tempDir();
    const into = await tempDir();
    await mkdir(path.join(source, 'uploads', 'images'), { recursive: true });
    await writeFile(path.join(source, 'uploads', 'images', 'a.webp'), 'bytes');

    const result = await runBackup(planBackup([source], into));

    expect(result.failures).toEqual([]);
    expect(result.copied).toHaveLength(1);
    const landed = path.join(into, path.basename(source), 'uploads', 'images', 'a.webp');
    expect(await readFile(landed, 'utf8')).toBe('bytes');
  });

  it('reports a folder it could not copy instead of abandoning the rest', async () => {
    // The operator is about to erase all of it: a partial copy of two folders
    // beats a complete copy of none.
    const good = await tempDir();
    const into = await tempDir();
    await writeFile(path.join(good, 'keep.txt'), 'kept');

    const result = await runBackup(planBackup([path.join(into, 'nope'), good], into));

    expect(result.copied.map((plan) => plan.from)).toEqual([good]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.from).toContain('nope');
  });
});

describe('choosing somewhere safe to put it', () => {
  it('refuses a destination inside a folder that is about to be erased', () => {
    // The backup would go with the thing it was taken from, and the report
    // would say it succeeded.
    expect(isSafeDestination('/data/master/backup', ['/data/master'])).toBe(false);
    expect(isSafeDestination('/data/master', ['/data/master'])).toBe(false);
  });

  it('allows a sibling, and anywhere unrelated', () => {
    expect(isSafeDestination('/data/master-backup', ['/data/master'])).toBe(true);
    expect(isSafeDestination('/mnt/usb', ['/data/master', '/data/office'])).toBe(true);
  });

  it('is not fooled by a name that merely starts the same', () => {
    // `/data/master2` is not inside `/data/master`, and refusing it would send
    // somebody hunting for a reason that does not exist.
    expect(isSafeDestination('/data/master2', ['/data/master'])).toBe(true);
  });
});
