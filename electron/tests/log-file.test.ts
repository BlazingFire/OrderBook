/**
 * The shell's log rotates while it runs, not only at start (`lib/log-file.ts`).
 * A Master left on for weeks used to grow one file without bound.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openLogFile } from '../lib/log-file.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-log-file-'));
  file = path.join(dir, 'shell.log');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const read = (name: string): string =>
  fs.existsSync(name) ? fs.readFileSync(name, 'utf8') : '';

describe('openLogFile', () => {
  it('rotates once the file passes its size while running', async () => {
    const log = openLogFile(file, false, 200);
    log.writeRaw('first\n');
    // Let the stream open its file before the write that rotates it.
    await vi.waitFor(() => expect(read(file)).toContain('first'));

    log.writeRaw(`${'x'.repeat(250)}\n`);
    log.writeRaw('after\n');
    log.close();

    await vi.waitFor(() => {
      expect(read(`${file}.1`)).toContain('first');
      expect(read(`${file}.1`)).toContain('x'.repeat(250));
      expect(read(file)).toBe('after\n');
    });
  });

  it('keeps three old files and drops the oldest', async () => {
    for (const [index, body] of [
      [1, 'one'],
      [2, 'two'],
      [3, 'three'],
    ] as const) {
      fs.writeFileSync(`${file}.${index}`, body);
    }
    fs.writeFileSync(file, 'y'.repeat(300));

    // An oversized file left from last time rotates at open.
    const log = openLogFile(file, false, 200);
    log.writeRaw('fresh\n');
    log.close();

    await vi.waitFor(() => expect(read(file)).toBe('fresh\n'));
    expect(read(`${file}.1`)).toBe('y'.repeat(300));
    expect(read(`${file}.2`)).toBe('one');
    expect(read(`${file}.3`)).toBe('two');
    expect(fs.existsSync(`${file}.4`)).toBe(false);
  });

  it('keeps the old files, and stops retrying every line, when the live file will not move', async () => {
    fs.writeFileSync(`${file}.1`, 'one');
    const log = openLogFile(file, false, 200);
    log.writeRaw('first\n');
    await vi.waitFor(() => expect(read(file)).toContain('first'));

    // Another program holding the file open, as a technician tailing it does.
    // Only the live file is held; the old ones still move if asked to.
    const realRename = fs.renameSync;
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (from === file) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      realRename(from, to);
    });
    log.writeRaw(`${'x'.repeat(250)}\n`);
    for (let line = 0; line < 5; line += 1) log.writeRaw('more\n');
    log.close();

    expect(rename.mock.calls.filter(([from]) => from === file)).toHaveLength(1);
    expect(read(`${file}.1`)).toBe('one');
    expect(fs.existsSync(`${file}.2`)).toBe(false);
  });

  it('never throws when the folder cannot be written', () => {
    // A file where the folder should be: mkdir fails, so there is no stream.
    const blocker = path.join(dir, 'blocked');
    fs.writeFileSync(blocker, '');
    const log = openLogFile(path.join(blocker, 'shell.log'), false, 10);
    expect(() => {
      log.write('a line');
      log.writeRaw('x'.repeat(50));
      log.close();
    }).not.toThrow();
  });
});
