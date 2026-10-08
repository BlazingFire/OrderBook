/**
 * The bulk photo import's matching and run (`shared/src/domain/photo-import.ts`).
 *
 * Pinned here because a mistake in either is invisible on screen until a
 * thousand photos have gone to the wrong sub products, or a "replace" has taken
 * a primary photo that a `_2` file was only meant to sit beside.
 */

import { describe, expect, it } from 'vitest';

import type { Product, ProductImage } from '../src/domain/entities.js';
import {
  isImageBytes,
  newestImageId,
  photoFileKey,
  planPhotoImport,
  runPhotoImport,
  type PhotoImportDeps,
  type PhotoFileLike,
} from '../src/domain/photo-import.js';

function image(id: string, sequence: number, isPrimary = false): ProductImage {
  return { id, sequence, isPrimary } as ProductImage;
}

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

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const WEBP = new Uint8Array([...'RIFF'].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0], [...'WEBP'].map((c) => c.charCodeAt(0))));
const TEXT = new TextEncoder().encode('just some notes, not a photo');

const file = (name: string, head?: Uint8Array): PhotoFileLike => (head ? { name, head } : { name });

const catalogue = [
  product('P1', [['OPT-0011', null]]),
  product('P2', [
    ['DAM-0041', 'Blue'],
    ['DAM-0042', 'Ivory'],
  ]),
  // Gallery order is primary first, then sequence: old-1 is photo 1 though its sequence is higher.
  product('P3', [['WB-0001', null]], { alias: 'Royal', images: [image('old-2', 0), image('old-1', 5, true)] }),
  product('P4', [['X-1', null]], { alias: 'twin' }),
  product('P5', [['X-2', null]], { alias: 'Twin' }),
  // An alias spelling another sub product's code: the code wins.
  product('P6', [['X-3', null]], { alias: 'opt-0011' }),
  // One photo only: a `_2` sits beside it, never in its place.
  product('P7', [['TTW-0016', null]], { images: [image('corner-1', 0, true)] }),
];

describe('photoFileKey', () => {
  it('reads the code and the slot from the name, ignoring case', () => {
    expect(photoFileKey('OPT-0011.JPG')).toMatchObject({ code: 'opt-0011', full: 'opt-0011', slot: 1 });
    expect(photoFileKey('OPT-0011_2.jpeg')).toMatchObject({ code: 'opt-0011', full: 'opt-0011_2', slot: 2 });
    expect(photoFileKey('OPT-0011_12.jpg')).toMatchObject({ code: 'opt-0011', slot: 12 });
  });

  it('does not read _1 as a slot: that would be a second spelling of photo 1', () => {
    expect(photoFileKey('OPT-0011_1.jpg')).toMatchObject({ code: 'opt-0011_1', slot: 1 });
  });

  it('refuses names that are not a photo', () => {
    expect(photoFileKey('mapping.csv')).toBeNull();
    expect(photoFileKey('OPT-0011')).toBeNull();
    expect(photoFileKey('.jpg')).toBeNull();
  });
});

describe('isImageBytes', () => {
  it('knows JPEG, PNG and WebP by their first bytes, and nothing else', () => {
    expect(isImageBytes(JPEG)).toBe(true);
    expect(isImageBytes(PNG)).toBe(true);
    expect(isImageBytes(WEBP)).toBe(true);
    expect(isImageBytes(TEXT)).toBe(false);
    expect(isImageBytes(new Uint8Array())).toBe(false);
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
    expect(row('OPT-0011.png')).toMatchObject({ status: 'new', productId: 'P1', matchedAs: 'OPT-0011', slot: 1 });
    expect(row('OPT-0011_2.jpg')).toMatchObject({ status: 'new', productId: 'P1', slot: 2 });
  });

  it('marks the second file with the same name as a duplicate, naming the one imported', () => {
    // Exact case wins over the folder's order and over the alphabet.
    expect(row('opt-0011.jpg')).toMatchObject({ status: 'duplicate', duplicateOf: 'OPT-0011.png' });
  });

  it('picks the same winner whatever order the files arrive in', () => {
    const forward = planPhotoImport([file('opt-0011.jpg'), file('OPT-0011.JPG')], catalogue);
    const backward = planPhotoImport([file('OPT-0011.JPG'), file('opt-0011.jpg')], catalogue);
    for (const result of [forward, backward]) {
      expect(result.find((entry) => entry.status !== 'duplicate')?.fileName).toBe('OPT-0011.JPG');
    }
    // Exact case wins even where the alphabet would pick the other ('AB' sorts before 'Ab').
    const mixed = planPhotoImport([file('AB-1.jpg'), file('Ab-1.png')], [product('P8', [['Ab-1', null]])]);
    expect(mixed.find((entry) => entry.status === 'duplicate')).toMatchObject({ fileName: 'AB-1.jpg', duplicateOf: 'Ab-1.png' });
    // Neither spelled as the catalogue: the first alphabetically, by code point.
    const neither = planPhotoImport([file('nope-9.jpg'), file('NOPE-9.png')], catalogue);
    expect(neither.find((entry) => entry.status === 'duplicate')?.duplicateOf).toBe('NOPE-9.png');
  });

  it('captions a photo matched through a colour code with that colour', () => {
    expect(row('DAM-0042.webp')).toMatchObject({ status: 'new', productId: 'P2', caption: 'Ivory' });
  });

  it('matches an alias, and names the photo already in slot 1 by gallery order', () => {
    expect(row('royal.jpg')).toMatchObject({
      status: 'hasPhoto',
      productId: 'P3',
      matchedAs: 'Royal',
      slot: 1,
      slotImageId: 'old-1',
      existingImageIds: ['old-1', 'old-2'],
    });
  });

  it('treats a _2 beside a single photo as a new photo 2, not as a photo already there', () => {
    const [second] = planPhotoImport([file('TTW-0016_2.jpg')], catalogue);
    expect(second).toMatchObject({ status: 'new', slot: 2 });
    expect(second?.slotImageId).toBeUndefined();
  });

  it('reads a whole name that is a code as photo 1 of that code, not as photo 2 of a shorter code', () => {
    const both = [product('A', [['OPT-0002', null]]), product('B', [['OPT-0002_2', null]])];
    const plan = planPhotoImport([file('OPT-0002_2.webp'), file('OPT-0002_2_2.webp'), file('OPT-0002_3.webp')], both);
    const at = (name: string) => plan.find((entry) => entry.fileName === name);
    expect(at('OPT-0002_2.webp')).toMatchObject({ status: 'new', productId: 'B', matchedAs: 'OPT-0002_2', slot: 1 });
    expect(at('OPT-0002_2_2.webp')).toMatchObject({ status: 'new', productId: 'B', slot: 2 });
    expect(at('OPT-0002_3.webp')).toMatchObject({ status: 'new', productId: 'A', slot: 3 });
    // Without that code, the same name is photo 2 of the shorter one, as before.
    expect(planPhotoImport([file('OPT-0002_2.webp')], [both[0]!])).toMatchObject([{ productId: 'A', slot: 2 }]);
  });

  it('matches nothing through an alias two sub products share', () => {
    expect(row('twin.jpg')?.status).toBe('unmatched');
  });

  it('reports unknown codes and files that are not photos', () => {
    expect(row('NOPE-1.jpg')?.status).toBe('unmatched');
    expect(row('mapping.csv')?.status).toBe('notImage');
  });

  it('flags a file whose bytes are not a photo before any upload, whatever its name', () => {
    const sniffed = planPhotoImport([file('OPT-0011.jpg', TEXT), file('opt-0011.png', PNG)], catalogue);
    expect(sniffed.find((entry) => entry.fileName === 'OPT-0011.jpg')?.status).toBe('notImage');
    // A file that is not a photo never wins a shared name.
    expect(sniffed.find((entry) => entry.fileName === 'opt-0011.png')?.status).toBe('new');
  });
});

function recorder(failFor: string[] = [], rateLimitedOnce: string[] = []) {
  const calls: string[] = [];
  const limited = new Set(rateLimitedOnce);
  const waits: number[] = [];
  const deps: PhotoImportDeps<PhotoFileLike> = {
    upload: async (productId, f, caption) => {
      if (limited.delete(f.name)) throw { rateLimited: 3000 };
      calls.push(`upload ${productId} ${f.name}${caption ? ` (${caption})` : ''}`);
      if (failFor.includes(f.name)) throw new Error('disk full');
      return `new-${f.name}`;
    },
    removeImage: async (productId, imageId) => {
      calls.push(`remove ${productId} ${imageId}`);
    },
    setPrimary: async (productId, imageId) => {
      calls.push(`primary ${productId} ${imageId}`);
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

  it('with "skip", uploads only into empty slots, so a second run adds nothing twice', async () => {
    const { calls, deps } = recorder();
    const outcomes = await runPhotoImport(plan, 'skip', deps);
    expect(calls).toEqual(['upload P1 OPT-0011.jpg']);
    expect(outcomes.map((outcome) => [outcome.row.fileName, outcome.result])).toEqual([
      ['NOPE.jpg', 'skipped'],
      ['OPT-0011.jpg', 'imported'],
      ['WB-0001.jpg', 'skipped'],
    ]);
  });

  it('with "replace", makes the new photo 1 primary, then removes only the old photo 1', async () => {
    const { calls, deps } = recorder();
    await runPhotoImport(plan, 'replace', deps);
    expect(calls).toEqual([
      'upload P1 OPT-0011.jpg',
      'upload P3 WB-0001.jpg',
      'primary P3 new-WB-0001.jpg',
      'remove P3 old-1',
    ]);
  });

  it('adds a _2 beside the primary in either mode, removing nothing', async () => {
    for (const mode of ['skip', 'replace'] as const) {
      const { calls, deps } = recorder();
      await runPhotoImport(planPhotoImport([file('TTW-0016_2.jpg')], catalogue), mode, deps);
      expect(calls).toEqual(['upload P7 TTW-0016_2.jpg']);
    }
  });

  it('with "replace", swaps a _2 for photo 2 only, never the primary', async () => {
    const { calls, deps } = recorder();
    await runPhotoImport(planPhotoImport([file('WB-0001_2.jpg')], catalogue), 'replace', deps);
    expect(calls).toEqual(['upload P3 WB-0001_2.jpg', 'remove P3 old-2']);
  });

  it('keeps the old photos when the new one fails, and reports the failure', async () => {
    const { calls, deps } = recorder(['WB-0001.jpg']);
    const outcomes = await runPhotoImport(plan, 'replace', deps);
    expect(calls.filter((call) => !call.startsWith('upload'))).toEqual([]);
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
        const id = await deps.upload(...args);
        stop = true;
        return id;
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

describe('newestImageId', () => {
  it('is the photo with the highest sequence, which is the one an upload just added', () => {
    expect(newestImageId({ images: [image('a', 0, true), image('c', 7), image('b', 3)] })).toBe('c');
    expect(newestImageId({ images: [] })).toBeNull();
  });
});
