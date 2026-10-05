/**
 * A repeat view of a cached product image or avatar must be answered from the browser's cache or
 * with a 304, never re-sent: the ids are minted per upload, so the URL is versioned and the
 * bytes behind it cannot change.
 *
 * Pure — the cache directory is a temp folder.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/master-fetch.js', () => ({
  masterFetch: vi.fn().mockRejectedValue(new Error('This panel is not paired with a Master')),
}));

import * as pathsModule from '../src/config/paths.js';
import { createApp } from '../src/http/app.js';

const IMAGE_ID = '3f2b8c1e-5d4a-4e6b-9c7d-1a2b3c4d5e6f';
const AVATAR_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'ob-image-headers-'));
  mkdirSync(path.join(dir, 'images', IMAGE_ID), { recursive: true });
  writeFileSync(path.join(dir, 'images', IMAGE_ID, 'thumb.webp'), Buffer.from('not really webp'));
  mkdirSync(path.join(dir, 'avatars', AVATAR_ID), { recursive: true });
  writeFileSync(path.join(dir, 'avatars', AVATAR_ID, 'thumb.webp'), Buffer.from('not really webp'));
  const real = pathsModule.paths();
  vi.spyOn(pathsModule, 'paths').mockReturnValue({
    ...real,
    imagesDir: path.join(dir, 'images'),
    avatarsDir: path.join(dir, 'avatars'),
  });
});

afterAll(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe.each([
  ['product image', () => `/uploads/images/${IMAGE_ID}/thumb`],
  ['avatar', () => `/uploads/avatars/${AVATAR_ID}/thumb`],
])('the cached %s route', (_name, url) => {
  it('is immutable with a validator, and answers a repeat conditional request with 304', async () => {
    const app = createApp();
    const first = await request(app).get(url()).expect(200);
    expect(first.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(first.headers.etag).toBeTruthy();
    expect(first.headers['last-modified']).toBeTruthy();

    await request(app).get(url()).set('If-None-Match', first.headers.etag!).expect(304);
    await request(app).get(url()).set('If-Modified-Since', first.headers['last-modified']!).expect(304);
  });
});
