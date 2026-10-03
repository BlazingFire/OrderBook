/**
 * Writing and reading the plain-zip "backup all" archive
 * (`docs/7-STORAGE-BACKUP-RESTORE.md`). The rules about what an archive may
 * hold are in `domain/archive.ts`; this file only moves bytes.
 *
 * Both sides stream, one entry at a time, so a backup of a large photo library
 * costs a buffer, never the library. `archiver` writes zip64 by itself once
 * the archive passes 4 GB or 65,535 entries, and `yauzl` reads it.
 *
 * The reader runs with yauzl's own checks on: entry names are decoded and
 * refused when absolute, climbing (`..`) or carrying a backslash, and every
 * entry's stream fails if it inflates to a size other than the one its header
 * declares, which is what makes a size check against the manifest worth
 * anything.
 */

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { PassThrough, Readable, Transform } from 'node:stream';

import archiver from 'archiver';
import yauzl from 'yauzl';

import { MAX_ARCHIVE_ENTRIES } from '../domain/archive.js';
import { BackupError } from './errors.js';

export interface EntryDigest {
  bytes: number;
  sha256: string;
}

export type EntrySource = Readable | Iterable<string | Buffer> | AsyncIterable<string | Buffer>;

export interface ZipWriter {
  /**
   * Add one entry and wait until it is fully written, returning its
   * uncompressed size and sha256. One at a time: the next call waits for this
   * one, so only one source is ever open. `store` skips compression, for
   * photos that are already compressed.
   */
  appendEntry(name: string, source: EntrySource, options?: { store?: boolean }): Promise<EntryDigest>;
  /** Write the central directory and close the file. Resolves the archive's size. */
  finalize(): Promise<number>;
  /** Stop and close the file, after a failure. The caller removes it. */
  abort(): void;
}

const MIB = 1024 * 1024;

function writeFailure(error: unknown, written: number): Error {
  // A FAT32 drive refuses the byte that would take a file to 4 GiB.
  if ((error as NodeJS.ErrnoException | null)?.code === 'EFBIG') {
    return new BackupError('fat32TooLarge', 'error.validation.backupFat32TooLarge', {
      neededMb: Math.ceil(written / MIB),
    });
  }
  return error instanceof Error ? error : new Error(String(error));
}

export function createZipWriter(filePath: string): ZipWriter {
  const output = createWriteStream(filePath);
  const archive = archiver('zip', { zlib: { level: 6 } });

  let failure: Error | null = null;
  let rejectPending: ((error: Error) => void) | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const fail = (error: unknown) => {
    failure ??= writeFailure(error, archive.pointer());
    rejectPending?.(failure);
  };
  archive.on('error', fail);
  // archiver reports a missing file as a warning; here every entry is a stream
  // we opened, so any warning is a real failure.
  archive.on('warning', fail);
  output.on('error', fail);
  archive.pipe(output);

  function writeOne(name: string, source: EntrySource, store: boolean): Promise<EntryDigest> {
    if (failure) return Promise.reject(failure);

    const hash = createHash('sha256');
    let bytes = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        bytes += chunk.length;
        callback(null, chunk);
      },
    });
    const input = source instanceof Readable ? source : Readable.from(source);
    input.on('error', (error) => counter.destroy(error));
    input.pipe(counter);

    return new Promise<EntryDigest>((resolve, reject) => {
      const onEntry = (entry: archiver.EntryData) => {
        if (entry.name !== name) return;
        settle();
        resolve({ bytes, sha256: hash.digest('hex') });
      };
      const onError = (error: Error) => {
        settle();
        reject(error);
      };
      const settle = () => {
        archive.off('entry', onEntry);
        rejectPending = null;
      };
      rejectPending = onError;
      counter.on('error', (error) => {
        fail(error);
      });
      archive.on('entry', onEntry);
      archive.append(counter, { name, store });
    });
  }

  return {
    appendEntry(name, source, options = {}) {
      const next = queue.then(() => writeOne(name, source, options.store === true));
      queue = next.catch(() => undefined);
      return next;
    },

    async finalize() {
      await queue;
      if (failure) throw failure;
      await new Promise<void>((resolve, reject) => {
        output.once('close', resolve);
        rejectPending = reject;
        archive.finalize().catch(reject);
      });
      if (failure) throw failure;
      return archive.pointer();
    },

    abort() {
      archive.abort();
      output.destroy();
    },
  };
}

export interface ZipEntryInfo {
  name: string;
  /** Uncompressed size, from the central directory. */
  bytes: number;
}

export interface ZipReader {
  /** Every entry in the central directory, in order, duplicates included. */
  readonly entries: readonly ZipEntryInfo[];
  /** A stream of one entry's bytes. Fails if they inflate to a size other than declared. */
  openStream(name: string): Promise<Readable>;
  /** One small entry as UTF-8, refused when its declared size is over `maxBytes`. */
  readText(name: string, maxBytes: number): Promise<string>;
  /** Stream one entry through sha256, keeping nothing. */
  hashEntry(name: string): Promise<EntryDigest>;
  close(): void;
}

/** yauzl's name checks, as the archive's own refusal rather than a raw library message. */
function readFailure(error: Error): BackupError {
  const bad = /^(invalid relative path|absolute path|invalid characters in fileName): (.*)$/.exec(error.message);
  if (bad) return new BackupError('entryRejected', 'error.validation.archiveEntryRejected', { entry: bad[2]! });
  return new BackupError('notAnArchive', 'error.validation.archiveNotAnArchive');
}

export async function openZipReader(filePath: string, maxEntries = MAX_ARCHIVE_ENTRIES): Promise<ZipReader> {
  const zipfile = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(
      filePath,
      { lazyEntries: true, autoClose: false, decodeStrings: true, validateEntrySizes: true, strictFileNames: true },
      (error, opened) => (error || !opened ? reject(readFailure(error ?? new Error('no zip'))) : resolve(opened)),
    );
  });
  // The count is in the end record, so a hostile list is refused unread.
  if (zipfile.entryCount > maxEntries) {
    zipfile.close();
    throw new BackupError('notAnArchive', 'error.validation.archiveNotAnArchive');
  }

  const all: yauzl.Entry[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      zipfile.on('entry', (entry: yauzl.Entry) => {
        all.push(entry);
        zipfile.readEntry();
      });
      zipfile.once('end', () => resolve());
      zipfile.once('error', (error: Error) => reject(readFailure(error)));
      zipfile.readEntry();
    });
  } catch (error) {
    zipfile.close();
    throw error;
  }

  // The first of a duplicated name; `checkArchiveEntries` refuses duplicates
  // before anything is opened.
  const byName = new Map<string, yauzl.Entry>();
  for (const entry of all) if (!byName.has(entry.fileName)) byName.set(entry.fileName, entry);

  function openStream(name: string): Promise<Readable> {
    const entry = byName.get(name);
    if (!entry) return Promise.reject(new BackupError('corrupt_file', 'error.validation.backupCorruptFile'));
    if (entry.isEncrypted()) {
      return Promise.reject(new BackupError('entryRejected', 'error.validation.archiveEntryRejected', { entry: name }));
    }
    return new Promise((resolve, reject) => {
      zipfile.openReadStream(entry, (error, stream) => {
        if (error || !stream) return reject(error);
        // A stored entry comes back as fd-slicer's own stream, which never
        // ends under `for await`; piped through a PassThrough it behaves.
        const through = new PassThrough();
        stream.on('error', (streamError) => through.destroy(streamError));
        resolve(stream.pipe(through));
      });
    });
  }

  return {
    entries: all.map((entry) => ({ name: entry.fileName, bytes: entry.uncompressedSize })),

    openStream,

    async readText(name, maxBytes) {
      const entry = byName.get(name);
      if (entry && entry.uncompressedSize > maxBytes) {
        throw new BackupError('entryRejected', 'error.validation.archiveEntryRejected', { entry: name });
      }
      const chunks: Buffer[] = [];
      for await (const chunk of await openStream(name)) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks).toString('utf8');
    },

    async hashEntry(name) {
      const hash = createHash('sha256');
      let bytes = 0;
      for await (const chunk of await openStream(name)) {
        hash.update(chunk as Buffer);
        bytes += (chunk as Buffer).length;
      }
      return { bytes, sha256: hash.digest('hex') };
    },

    close() {
      zipfile.close();
    },
  };
}
