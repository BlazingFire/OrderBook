/**
 * `keepPrivate`: a new secret loses what it inherited, and whoever made it can still
 * use it. The failure that matters is locking this Master out of its own password.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { keepPrivate } from '../src/lib/private-path.js';

const onWindows = process.platform === 'win32';
const acl = (target: string): string => execFileSync('icacls', [target], { encoding: 'utf8' });

describe('keepPrivate', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ob-private-path-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('never throws on something that is not there: a failure is only a warning', () => {
    expect(() => keepPrivate(path.join(dir, 'missing'))).not.toThrow();
  });

  it.runIf(onWindows)('cuts a file off from what it inherited, and this account can still use it', () => {
    const file = path.join(dir, 'secret');
    writeFileSync(file, 'one');
    expect(acl(file)).toContain('(I)');

    keepPrivate(file);

    expect(acl(file)).not.toContain('(I)');
    expect(readFileSync(file, 'utf8')).toBe('one');
    writeFileSync(file, 'two');
    expect(readFileSync(file, 'utf8')).toBe('two');
  });

  it.runIf(onWindows)('makes a folder pass that on to the files later written in it', () => {
    const folder = path.join(dir, 'secrets');
    execFileSync('cmd', ['/c', 'mkdir', folder]);

    keepPrivate(folder);
    const file = path.join(folder, 'vault.key');
    writeFileSync(file, 'key');

    expect(readFileSync(file, 'utf8')).toBe('key');
    expect(existsSync(file)).toBe(true);
    expect(acl(folder)).toContain('(OI)(CI)');
  });
});
