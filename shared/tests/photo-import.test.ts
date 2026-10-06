/**
 * The bulk photo import's matching and run (`shared/src/domain/photo-import.ts`).
 *
 * Pinned here because a mistake in either is invisible on screen until a
 * thousand photos have gone to the wrong sub products, or a "replace" has left
 * one with no photo at all.
 */

import { describe, expect, it } from 'vitest';

import type { Product } from '../src/domain/entities.js';
import { photoFileKey, planPhotoImport, runPhotoImport, type PhotoImportDeps } from '../src/domain/photo-import.js';

function product(id: string, codes: Array<[string, string | null]>, extra: Partial<Product> = {}): Product {
  return {
    id,
    name: `Model ${id}`,
    alias: null,
    hasVariants: codes.length > 1,
    variants: codes.map(([code, label], sequence) => ({
      id: `${id}-v${sequence}`,
      productId: id,
      code,
      label,
      weightKg: null,
      sequence,
      isActive: true,
    })),
    images: [],
    ...extra,
  } as Product;
}

const file = (name: string) => ({ name });

const catalogue = [
  product('P1', [['OPT-0011', null]]),
  product('P2', [
    ['DAM-0041', 'Blue'],
    ['DAM-0042', 'Ivory'],
  ]),
  product('P3', [['WB-0001', null]], { alias: 'Royal', images: [{ id: 'old-1' }, { id: 'old-2' }] as Product['images'] }),
  product('P4', [['X-1', null]], { alias: 'twin' }),
  product('P5', [['X-2', null]], { alias: 'Twin' }),
  // An alias spelling another sub product's code: the code wins.
  product('P6', [['X-3', null]], { alias: 'opt-0011' }),
];

describe('photoFileKey', () => {
  it('reads the code from the name, ignoring case and a _N second-photo suffix', () => {
    expect(photoFileKey('OPT-0011.JPG')).toEqual({ code: 'opt-0011', full: 'opt-0011' });
    expect(photoFileKey('OPT-0011_2.jpeg')).toEqual({ code: 'opt-0011', full: 'opt-0011_2' });
  });

  it('refuses names that are not a photo', () => {
    expect(photoFileKey('mapping.csv')).toBeNull();
    expect(photoFileKey('OPT-0011')).toBeNull();
    expect(photoFileKey('.jpg')).toBeNull();
  });
});

describe('planPhotoImport', () => {
  const plan = planPhotoImport(
    [
      file('opt-0011.jpg'),
      file('OPT-0011.png'),
      file('OPT-0011_2.jpg'),
      file('DAM-0042.webp'),
      file('royal.jpg'),
      file('twin.jpg'),
      file('NOPE-1.jpg'),
      file('mapping.csv'),
    ],
    catalogue,
  );
  const row = (name: string) => plan.find((entry) => entry.fileName === name);

  it('matches a code whatever its case, and a second photo of it', () => {
    expect(row('opt-0011.jpg')).toMatchObject({ status: 'new', productId: 'P1', matchedAs: 'OPT-0011' });
    expect(row('OPT-0011_2.jpg')).toMatchObject({ status: 'new', productId: 'P1' });
  });

  it('marks the second file with the same name as a duplicate, not a second photo', () => {
    // Sorted by name, so which one is kept does not depend on the folder's order.
    expect(row('OPT-0011.png')?.status).toBe('duplicate');
  });

  it('captions a photo matched through a colour code with that colour', () => {
    expect(row('DAM-0042.webp')).toMatchObject({ status: 'new', productId: 'P2', caption: 'Ivory' });
  });

  it('matches an alias, and says the sub product already has photos', () => {
    expect(row('royal.jpg')).toMatchObject({
      status: 'hasPhoto',
      productId: 'P3',
      matchedAs: 'Royal',
      existingImageIds: ['old-1', 'old-2'],
    });
  });

  it('matches nothing through an alias two sub products share', () => {
    expect(row('twin.jpg')?.status).toBe('unmatched');
  });

  it('reports unknown codes and files that are not photos', () => {
    expect(row('NOPE-1.jpg')?.status).toBe('unmatched');
    expect(row('mapping.csv')?.status).toBe('notImage');
  });
});

function recorder(failFor: string[] = [], rateLimitedOnce: string[] = []) {
  const calls: string[] = [];
  const limited = new Set(rateLimitedOnce);
  const waits: number[] = [];
  const deps: PhotoImportDeps<{ name: string }> = {
    upload: async (productId, f, caption) => {
      if (limited.delete(f.name)) throw { rateLimited: 3000 };
      calls.push(`upload ${productId} ${f.name}${caption ? ` (${caption})` : ''}`);
      if (failFor.includes(f.name)) throw new Error('disk full');
    },
    removeImage: async (productId, imageId) => {
      calls.push(`remove ${productId} ${imageId}`);
    },
    retryAfterMs: (error) => (error as { rateLimited?: number }).rateLimited ?? null,
    errorText: (error) => (error as Error).message,
    wait: async (ms) => {
      waits.push(ms);
    },
  };
  return { calls, deps, waits };
}

describe('runPhotoImport', () => {
  const plan = planPhotoImport([file('WB-0001.jpg'), file('OPT-0011.jpg'), file('NOPE.jpg')], catalogue);

  it('with "skip", uploads only to sub products with no photo, so a second run adds nothing twice', async () => {
    const { calls, deps } = recorder();
    const outcomes = await runPhotoImport(plan, 'skip', deps);
    expect(calls).toEqual(['upload P1 OPT-0011.jpg']);
    expect(outcomes.map((outcome) => [outcome.row.fileName, outcome.result])).toEqual([
      ['NOPE.jpg', 'skipped'],
      ['OPT-0011.jpg', 'imported'],
      ['WB-0001.jpg', 'skipped'],
    ]);
  });

  it('with "replace", removes the old photos only after the new one is in', async () => {
    const { calls, deps } = recorder();
    await runPhotoImport(plan, 'replace', deps);
    expect(calls).toEqual([
      'upload P1 OPT-0011.jpg',
      'upload P3 WB-0001.jpg',
      'remove P3 old-1',
      'remove P3 old-2',
    ]);
  });

  it('keeps the old photos when the new one fails, and reports the failure', async () => {
    const { calls, deps } = recorder(['WB-0001.jpg']);
    const outcomes = await runPhotoImport(plan, 'replace', deps);
    expect(calls.filter((call) => call.startsWith('remove'))).toEqual([]);
    expect(outcomes.find((outcome) => outcome.row.fileName === 'WB-0001.jpg')).toMatchObject({
      result: 'failed',
      error: 'disk full',
    });
  });

  it('waits out the Master upload limit and tries the same photo again', async () => {
    const { calls, deps, waits } = recorder([], ['OPT-0011.jpg']);
    const outcomes = await runPhotoImport(plan, 'skip', deps);
    expect(waits).toEqual([3000]);
    expect(calls).toEqual(['upload P1 OPT-0011.jpg']);
    expect(outcomes.find((outcome) => outcome.row.fileName === 'OPT-0011.jpg')?.result).toBe('imported');
  });

  it('stops between photos when asked, reporting the rest as skipped', async () => {
    const { calls, deps } = recorder();
    let stop = false;
    const outcomes = await runPhotoImport(plan, 'replace', {
      ...deps,
      upload: async (...args) => {
        await deps.upload(...args);
        stop = true;
      },
      stopped: () => stop,
    });
    expect(calls).toEqual(['upload P1 OPT-0011.jpg']);
    expect(outcomes.find((outcome) => outcome.row.fileName === 'WB-0001.jpg')?.result).toBe('skipped');
  });

  it('reports progress over the photos it means to upload', async () => {
    const { deps } = recorder();
    const seen: string[] = [];
    await runPhotoImport(plan, 'replace', { ...deps, onProgress: (done, total) => seen.push(`${done}/${total}`) });
    expect(seen).toEqual(['0/2', '1/2', '2/2']);
  });
});
