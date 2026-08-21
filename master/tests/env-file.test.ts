/**
 * The `.env` loader is the first thing that runs at startup, and it parses a
 * file people edit by hand in Notepad. A stray carriage return inside a
 * connection string, or a quoted Windows path kept with its quotes, produces a
 * confusing failure much later — so the parsing rules are pinned here.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadEnvFiles } from '../src/lib/env-file.js';

let dir: string;
const touchedKeys = [
  'TEST_DATABASE_URL',
  'TEST_WINDOWS_PATH',
  'TEST_PORT',
  'TEST_ALREADY_SET',
  'TEST_NOT_A_PAIR',
  'TEST_EMPTY',
  'TEST_SECOND_FILE',
  'TEST_OVERRIDE',
];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orderbook-env-'));
  for (const key of touchedKeys) delete process.env[key];
});

afterEach(async () => {
  for (const key of touchedKeys) delete process.env[key];
  await fs.rm(dir, { recursive: true, force: true });
});

async function writeEnv(name: string, contents: string): Promise<string> {
  const file = path.join(dir, name);
  await fs.writeFile(file, contents);
  return file;
}

describe('loadEnvFiles', () => {
  it('reads a plain KEY=value line', async () => {
    const file = await writeEnv('.env', 'TEST_PORT=4100\n');
    loadEnvFiles(file);

    expect(process.env.TEST_PORT).toBe('4100');
  });

  it('keeps colons and slashes in a connection string intact', async () => {
    const url = 'postgres://postgres:postgresql@localhost:5432/order_book';
    const file = await writeEnv('.env', `TEST_DATABASE_URL=${url}\n`);
    loadEnvFiles(file);

    expect(process.env.TEST_DATABASE_URL).toBe(url);
  });

  it('handles a file written with Windows CRLF line endings', async () => {
    // Notepad writes CRLF. Splitting on \n alone would leave a trailing \r on
    // every value, which breaks a connection string in a way that is very hard
    // to see in a log.
    const url = 'postgres://postgres:postgresql@localhost:5432/order_book';
    const file = await writeEnv('.env', `# config\r\n\r\nTEST_DATABASE_URL=${url}\r\n`);
    loadEnvFiles(file);

    expect(process.env.TEST_DATABASE_URL).toBe(url);
    expect(process.env.TEST_DATABASE_URL).not.toMatch(/\r/);
  });

  it('strips surrounding quotes from a Windows path with spaces', async () => {
    const file = await writeEnv('.env', 'TEST_WINDOWS_PATH="C:\\Program Files\\PostgreSQL\\17\\bin"\n');
    loadEnvFiles(file);

    expect(process.env.TEST_WINDOWS_PATH).toBe('C:\\Program Files\\PostgreSQL\\17\\bin');
  });

  it('trims whitespace around the key and value', async () => {
    const file = await writeEnv('.env', '  TEST_PORT  =  4100  \n');
    loadEnvFiles(file);

    expect(process.env.TEST_PORT).toBe('4100');
  });

  it('ignores comments, blank lines and lines without a separator', async () => {
    const file = await writeEnv('.env', '# a comment\n\nTEST_NOT_A_PAIR\n   \nTEST_PORT=4100\n');
    loadEnvFiles(file);

    expect(process.env.TEST_NOT_A_PAIR).toBeUndefined();
    expect(process.env.TEST_PORT).toBe('4100');
  });

  it('lets a real environment variable win over the file', async () => {
    // A one-off `$env:DATABASE_URL=...` must still override .env for that run.
    process.env.TEST_ALREADY_SET = 'from-real-env';
    const file = await writeEnv('.env', 'TEST_ALREADY_SET=from-file\n');
    loadEnvFiles(file);

    expect(process.env.TEST_ALREADY_SET).toBe('from-real-env');
  });

  it('skips a file that does not exist instead of throwing', async () => {
    const present = await writeEnv('.env', 'TEST_PORT=4100\n');

    expect(() => loadEnvFiles(path.join(dir, 'absent.env'), present)).not.toThrow();
    expect(process.env.TEST_PORT).toBe('4100');
  });

  it('applies later files without overwriting what an earlier one set', async () => {
    // Both files are read, but the first value to be set wins — the same rule
    // that protects real environment variables.
    const first = await writeEnv('first.env', 'TEST_OVERRIDE=from-first\n');
    const second = await writeEnv('second.env', 'TEST_OVERRIDE=from-second\nTEST_SECOND_FILE=yes\n');
    loadEnvFiles(first, second);

    expect(process.env.TEST_OVERRIDE).toBe('from-first');
    expect(process.env.TEST_SECOND_FILE).toBe('yes');
  });

  it('accepts an empty value', async () => {
    const file = await writeEnv('.env', 'TEST_EMPTY=\n');
    loadEnvFiles(file);

    expect(process.env.TEST_EMPTY).toBe('');
  });
});
