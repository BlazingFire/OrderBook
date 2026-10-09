/**
 * The product backup zip: the whole catalogue as one file a person can open,
 * edit and put back (`docs/PRODUCT_IMPORT_FORMAT.md`, "The product backup zip").
 *
 *     products.csv         the sub product export, the import's own columns
 *     main-products.csv    Brand, Main product code, Main product, Order
 *     colours.csv          Colour, Label, Hex, Active: the colour list, in its order
 *     brands.csv           Brand, Label, Active: the Brands list, in its order
 *     images/OPT-0001.webp photo 1 of OPT-0001; OPT-0001_2.webp is photo 2
 *     photos.csv           File, Caption: each photo's caption, by its name in images/
 *     README.txt
 *
 * A bare products sheet restores too, as a zip holding only `products.csv`:
 * the CSV or XLSX the Products export saved before the zip existed
 * (`products-2026-10-07.csv`, 1.2.4–1.4.6) and the import template. In a zip,
 * the files those versions downloaded keep their dated names.
 *
 * **Nothing here is a second importer.** `products.csv` goes back through the
 * upsert import (`importProducts`, with `restore`), the photos through the bulk
 * photo import's planner and run (`shared/src/domain/photo-import.ts`) and the
 * ordinary one-photo upload, so a row or a photo lands exactly as one added on
 * the screens would. What the zip adds is the parts the CSV cannot carry: main
 * products created with their code, brand and order (a code never creates one
 * in the import, so an empty catalogue could not be restored), main products
 * renamed, recoded, reordered or brought back from the Recycle Bin, the colour
 * and brand lists, and photos compared by content.
 *
 * **Change detection is exact.** A photo is written as its stored `master.webp`,
 * byte for byte, so its sha256 is `product_images.checksum`, and another
 * Master stores that file as its master unchanged (`normalizeAndStore`). Any
 * other photo put in the zip (a jpg, png or webp) is re-encoded on upload, so
 * the row also keeps the hash of the file it came from, `source_checksum`.
 * Either hash of any photo of its sub product is an unchanged photo
 * (`planPhotos`). A row is unchanged by the import's own test
 * (`changedCells`), which also names each changed cell.
 *
 * **Missing is reported, not removed.** A sub product whose codes the file no
 * longer names, a photo of the file's sub products with no file, a main
 * product, colour or brand the files do not list, and a code of a file sub
 * product that its rows leave out, are listed. Only the opt-ins act on them:
 * the first moves sub products to the Recycle Bin through the ordinary delete
 * (so it can be undone), the second deletes the photos, and the third
 * (`exactCatalogue`) does both, moves the main products, colours and brands to
 * the Recycle Bin the same way, and removes those codes: the catalogue made
 * exactly the file, nothing of the one shipped with a new install left beside
 * it. Without one of the last two ticked, no photo is ever erased.
 *
 * **One function answers "what would this zip do" and "do it"** (`runZip`), as
 * the spreadsheet import does: the preview a person approves and the run that
 * follows cannot disagree. The real run encodes every new photo, which takes
 * minutes for a few hundred, so it runs detached as the one product restore
 * (`startProductRestore`), polled by the screen. It is its own slot, never the
 * backup/restore one: it replaces nothing wholesale and needs no maintenance.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

import {
  CATEGORY_CODE_PATTERN,
  galleryOrder,
  MAX_IMAGE_SOURCE_BYTES,
  MAX_PRODUCT_IMPORT_BYTES,
  newestImageId,
  photoFileKey,
  planPhotoImport,
  runPhotoImport,
  type MessageKey,
  type MessageParams,
  type OptionListItem,
  type PhotoPlanRow,
  type Product,
  type ProductCellChange,
  type ProductImage,
  type ProductRestoreJob,
  type ProductRestoreOptions,
  type ProductZipList,
  type ProductZipProblem,
  type ProductZipReport,
} from '@orderbook/shared';

import { config } from '../config/index.js';
import { actorCan, requirePermission, systemActor, type ActorContext } from '../domain/actor.js';
import { companySlug, MAX_ARCHIVE_ENTRIES } from '../domain/archive.js';
import {
  IMPORT_COLUMNS,
  isBlankRow,
  matchHeaders,
  normalizeHeader,
  type ImportField,
} from '../domain/product-import.js';
import { db } from '../db/knex.js';
import { createZipWriter, openZipReader, type ZipReader } from '../lib/archive-zip.js';
import { toCsv } from '../lib/csv.js';
import {
  AppError,
  BackupError,
  ConflictError,
  toErrorMessage,
  ValidationError,
} from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { readSheetRows } from '../lib/spreadsheet.js';
import * as activityLog from '../repositories/activity-log.repository.js';
import * as customFieldRepo from '../repositories/custom-field.repository.js';
import * as imageRepo from '../repositories/product-image.repository.js';
import * as productRepo from '../repositories/product.repository.js';
import * as settingsRepo from '../repositories/settings.repository.js';
import { resolveDefaultTenantId } from '../repositories/tenant.repository.js';
import type { TransactionContext } from '../repositories/transaction.js';
import { currentJob, isJobRunning } from './backup-job.js';
import * as catalog from './catalog.service.js';
import { retireCataloguePhotos, stopCataloguePhotos } from './catalogue-photos.service.js';
import {
  loadCatalogue,
  readCatalogueFile,
  SHIPPED_CATALOGUE_MARKER,
} from './catalogue-seed.service.js';
import { publishChange } from './change-bus.js';
import * as fields from './fields.service.js';
import { deleteImage, reorderImages, updateImageCaption, uploadImage } from './image.service.js';
import { buildProductExport, importProducts, registerBrands } from './product-import.service.js';
import { getIdentity, isSetupComplete } from './setup.service.js';

const log = createLogger('product-zip');

const PRODUCTS_CSV = 'products.csv';
const MAIN_PRODUCTS_CSV = 'main-products.csv';
const COLOURS_CSV = 'colours.csv';
const BRANDS_CSV = 'brands.csv';
const PHOTOS_CSV = 'photos.csv';
/** The names the Products export saved under from 1.2.4 on, a dated one or not, CSV or XLSX. */
const PRODUCT_SHEETS = /^products(-\d{4}-\d{2}-\d{2})?\.(csv|xlsx)$/i;
const MAIN_SHEETS = /^main-products(-\d{4}-\d{2}-\d{2})?\.(csv|xlsx)$/i;
const MAIN_HEADERS = ['Brand', 'Main product code', 'Main product', 'Order'];
const COLOUR_HEADERS = ['Colour', 'Label', 'Hex', 'Active'];
const BRAND_HEADERS = ['Brand', 'Label', 'Active'];
const PHOTO_HEADERS = ['File', 'Caption'];
const HEX = /^#[0-9a-f]{6}$/i;
const BOM = '﻿';

const labelOf = (field: ImportField): string =>
  IMPORT_COLUMNS.find((column) => column.field === field)?.label ?? field;

/** A file's name without the folders a person zipped it under. */
const baseName = (entry: string): string => entry.slice(entry.lastIndexOf('/') + 1);

/** The business day, `2026-10-08`, for the file name. */
function today(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: config.locale.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

// --- Export ------------------------------------------------------------------

/** Every code the photo planner matches a name against, lower-cased. */
const codesOf = (products: readonly Product[]): Set<string> =>
  new Set(
    products.flatMap((product) => product.variants.map((variant) => variant.code.toLowerCase())),
  );

/**
 * The name a photo goes out under: the code of the variant its caption names
 * (a sub product with several colours), else of its first live variant, and
 * `_N` past the first slot. A photo N whose `CODE_N` is another sub product's
 * code (the planner reads that name as the other one's photo 1) takes its sub
 * product's next live code instead. Null for a sub product with no live code,
 * and when every name the photo could take is another sub product's code.
 */
function photoBaseName(
  product: Product,
  image: ProductImage,
  slot: number,
  codes: ReadonlySet<string>,
): string | null {
  const live = product.variants.filter((variant) => variant.isActive);
  const caption = image.caption?.trim().toLowerCase();
  const named =
    product.hasVariants && caption
      ? live.find((candidate) => (candidate.label ?? '').trim().toLowerCase() === caption)
      : undefined;
  const candidates = named ? [named, ...live.filter((variant) => variant !== named)] : live;
  if (slot === 1) return candidates[0]?.code ?? null;
  return (
    candidates
      .map((variant) => `${variant.code}_${slot}`)
      .find((name) => !codes.has(name.toLowerCase())) ?? null
  );
}

/** What a file name cannot hold on Windows, and `%`, which marks one written as `%2F`. */
const UNSAFE = /["%*/:<>?\\|]/;

/** A code as a file name: `SW/101` goes out as `SW%2F101`. */
const fileSafe = (code: string): string =>
  code.replace(
    new RegExp(UNSAFE.source, 'g'),
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  );

/** And back; a `%` the export would not have written stays as it is. */
const fromFileSafe = (name: string): string =>
  name.replace(/%([0-9A-Fa-f]{2})/g, (text, hex: string) => {
    const char = String.fromCharCode(Number.parseInt(hex, 16));
    return UNSAFE.test(char) ? char : text;
  });

/** A sub product's photos in gallery order: entry N - 1 is slot N. */
function galleryImages(product: Product): ProductImage[] {
  const byId = new Map(product.images.map((image) => [image.id, image]));
  return galleryOrder(product).map((id) => byId.get(id) as ProductImage);
}

const masterFile = (tenantId: string, imageId: string): string =>
  path.join(config.imagesDir, tenantId, imageId, 'master.webp');

const exists = (file: string): Promise<boolean> =>
  access(file).then(
    () => true,
    () => false,
  );

/** `unnamed`: the photos left out, because no name would bring them back or their file is missing, as "sub product, photo N". */
function readme(company: string, date: string, unnamed: readonly string[]): string {
  return [
    'OrderBook product backup',
    '========================',
    '',
    `The product catalogue of ${company}, taken on ${date}.`,
    '',
    'WHAT IS IN THIS ZIP',
    '',
    '  products.csv       One row per sub product, in catalogue order: Brand, Main product code,',
    '                     Main product, Sub product, Size, Colour rule, Colour, Code, Weight (kg), Alias.',
    '  main-products.csv  Every main product, one with no sub product too: its code, brand and',
    '                     Order, its place in the catalogue (a blank Order lists after the',
    '                     numbered ones, by name).',
    '  colours.csv        The colour list in its order: each colour, its label, its hex value',
    '                     and Active (yes, or no for one switched off).',
    '  brands.csv         The Brands list in its order: each brand, its label and Active.',
    '  images             Every product photo, named by the sub product Code:',
    '                     OPT-0001.webp is the first (main) photo of OPT-0001,',
    '                     OPT-0001_2.webp its second photo, OPT-0001_3.webp its third.',
    '                     A Code holding a character a file name cannot (/ \\ : * ? " < > | %)',
    '                     has it written as % and two digits: SW/101 is SW%2F101.webp.',
    '  photos.csv         The caption of each photo in the images folder, by its file name.',
    '',
    'HOW TO EDIT',
    '',
    '  1. Unzip it, change what you need, and zip the folder again with any zip tool.',
    '  2. Change a cell to change that value. Leave the Code column as it is: the Code is how',
    '     each row finds its sub product.',
    '  3. To add a sub product, add a row with a new Code that no other row uses.',
    '  4. To rename a main product, or change its brand or Order, change it in main-products.csv:',
    '     the Main product and Brand cells of products.csv are not read for a main product listed',
    '     there. One listed with the brand and name of a main product you have, under another',
    '     code, is that main product: it takes the code of the file.',
    '  5. colours.csv and brands.csv are those lists as they are: change a Label, a Hex or Active',
    '     there, or the order of the rows. One the list lacks is added; one the file leaves out',
    '     stays as it is, unless you tick "Make the catalogue exactly this file".',
    '  6. To replace a photo, put the new picture in the images folder under the same name and',
    '     delete the old file, even when the ending differs: OPT-0001.jpg replaces OPT-0001.webp.',
    '     jpg, png and webp pictures are accepted.',
    '  7. To add a second photo, name it OPT-0001_2.jpg (a third: OPT-0001_3.jpg, and so on).',
    "  8. To change a photo's caption, change it in photos.csv.",
    '  9. On the Master, open Products > Sub products > Restore from .zip and choose the zip.',
    '     It lists every change first; nothing is saved until you press Apply.',
    '',
    'WHAT REMOVING DOES',
    '',
    '  A row deleted from products.csv, or a photo deleted from the images folder, is only',
    '  listed when you restore. Nothing is removed unless you tick "Move sub products missing',
    '  from the file to the Recycle Bin" or "Remove photos missing from the zip". Sub products',
    '  in the Recycle Bin can be brought back from there; a removed photo cannot. A main',
    '  product or sub product in the Recycle Bin whose code the zip names comes back from there.',
    '',
    '  "Make the catalogue exactly this file" does both, and leaves nothing beside what the',
    '  zip holds, so a new install keeps nothing of the catalogue it came with. Main products',
    '  neither CSV names, and the colours and brands colours.csv and brands.csv do not list',
    '  (with no brands.csv: the brands no main product has), go to the Recycle Bin too. A zip',
    '  with no colours.csv leaves the colours as they are. A Code of a sub product that its',
    '  rows no longer list is removed for good; a photo the images folder holds under it stays.',
    '',
    'EXCEL',
    '',
    '  Excel changes some values when it opens a CSV file: a size like 10-12 can turn into a',
    '  date, and a number can lose its leading zeros. Check those cells before saving, and save',
    '  as "CSV UTF-8 (Comma delimited)". Notepad and LibreOffice leave the values as they are.',
    '',
    'PHOTOS',
    '',
    '  A photo is recognised as unchanged by its exact bytes, whatever its number: one you did',
    '  not touch, and one you put in that a restore has already brought in. It stays as it is,',
    "  in the zip's order. Restoring the same zip twice adds nothing.",
    '',
    ...(unnamed.length > 0
      ? [
          'NOT IN THIS ZIP',
          '',
          '  These photos are not in the images folder: their sub product has no Code in use, the',
          '  name the photo would take is the Code of another sub product, or its file is missing',
          "  from this Master's data folder. Restoring this zip leaves them as they are.",
          '',
          ...unnamed.map((photo) => `  ${photo}`),
          '',
        ]
      : []),
  ].join('\r\n');
}

/**
 * Write the whole catalogue as one zip in the data folder's `tmp`, for the
 * route to stream and then delete: never held in memory, however many photos.
 * Needs `products.export` on top of seeing the catalogue: this is the whole
 * catalogue with every photo, the export the key is for.
 */
export async function exportProductZip(
  actor: ActorContext,
): Promise<{ filePath: string; fileName: string }> {
  requirePermission(actor, 'products.view');
  requirePermission(actor, 'products.export');
  const { tenantId } = actor;

  const company = (await getIdentity())?.companyName ?? null;
  const date = today();
  const fileName = `OrderBook-Products-${companySlug(company)}-${date}.zip`;
  const dir = path.join(config.dataDir, 'tmp');
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `product-backup-${randomUUID()}.zip`);

  const writer = createZipWriter(filePath);
  let photos = 0;
  let count = 0;
  try {
    const productsCsv = await buildProductExport('csv', actor, 'sub');
    count = productsCsv.count;
    await writer.appendEntry(PRODUCTS_CSV, [productsCsv.bytes]);

    // Order is the stored one, blank where it has none: the list sorts by it, then by name.
    const categories = await productRepo.listCategories(tenantId);
    const mainRows = categories.map((category) => [
      category.brand ?? '',
      category.code ?? '',
      category.name,
      category.sortOrder ?? '',
    ]);
    await writer.appendEntry(MAIN_PRODUCTS_CSV, [BOM + toCsv(MAIN_HEADERS, mainRows)]);

    // Every value in the list, one switched off too, in the list's order.
    const colours = await customFieldRepo.listOptionsForKey(tenantId, 'stock.colour');
    const colourRows = colours.map((option) => [
      option.value,
      option.label,
      option.hex ?? '',
      yesNo(option.isActive),
    ]);
    await writer.appendEntry(COLOURS_CSV, [BOM + toCsv(COLOUR_HEADERS, colourRows)]);
    const brands = await customFieldRepo.listOptionsForKey(tenantId, 'product.brand');
    const brandRows = brands.map((option) => [option.value, option.label, yesNo(option.isActive)]);
    await writer.appendEntry(BRANDS_CSV, [BOM + toCsv(BRAND_HEADERS, brandRows)]);

    const { items } = await productRepo.listProducts(tenantId, { limit: 100_000, offset: 0 });
    const codes = codesOf(items);
    const unnamed: string[] = [];
    const captions: string[][] = [];
    for (const product of items) {
      for (const [index, image] of galleryImages(product).entries()) {
        const name = photoBaseName(product, image, index + 1, codes);
        if (name === null) {
          unnamed.push(`${product.name}, photo ${index + 1}`);
          continue;
        }
        const source = masterFile(tenantId, image.id);
        // A row whose files are gone (healed on the next boot, if it was shipped) has nothing to write; the README says so.
        if (!(await exists(source))) {
          log.warn(`Photo ${image.id} of ${product.name} has no file to back up`);
          unnamed.push(`${product.name}, photo ${index + 1} (its file is missing)`);
          continue;
        }
        const file = `${fileSafe(name)}.webp`;
        // Already compressed: stored, so the bytes in the zip are the bytes on disk.
        await writer.appendEntry(`images/${file}`, createReadStream(source), { store: true });
        captions.push([file, image.caption ?? '']);
        photos += 1;
      }
    }
    if (unnamed.length > 0)
      log.warn(`${unnamed.length} photos are left out of the backup; its README lists them`);

    await writer.appendEntry(PHOTOS_CSV, [BOM + toCsv(PHOTO_HEADERS, captions)]);
    await writer.appendEntry('README.txt', [readme(company ?? 'this company', date, unnamed)]);
    await writer.finalize();
  } catch (error) {
    writer.abort();
    await rm(filePath, { force: true });
    throw error;
  }

  await db().transaction((trx) =>
    activityLog.recordActivity(
      {
        tenantId,
        entityType: 'catalog',
        entityId: tenantId,
        action: 'exported',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { count, level: 'zip', format: 'zip', fileName, photos },
      },
      actor,
      trx,
    ),
  );

  return { filePath, fileName };
}

// --- Reading a zip -------------------------------------------------------------

/** The library's refusal as the product zip's own sentence. */
function zipRefusal(error: unknown): unknown {
  if (error instanceof BackupError && error.reason === 'entryRejected') {
    return new ValidationError('validation.productZip.entryRejected', {
      entry: String(error.params.entry ?? ''),
    });
  }
  if (error instanceof BackupError) return new ValidationError('validation.productZip.notAZip');
  return error;
}

/** What this module reads of a zip: a bare sheet is one too (`sheetFiles`). */
type ZipFiles = Pick<ZipReader, 'entries' | 'openStream' | 'close'>;

/** A bare sheet as a zip holding only `products.csv`, whatever its bytes: `readSheetRows` tells a CSV from an XLSX. */
async function sheetFiles(filePath: string): Promise<ZipFiles> {
  if ((await stat(filePath)).size > MAX_PRODUCT_IMPORT_BYTES)
    throw new ValidationError('validation.import.tooLarge');
  const bytes = await readFile(filePath);
  return {
    entries: [{ name: PRODUCTS_CSV, bytes: bytes.length }],
    openStream: async () => Readable.from([bytes]),
    close: () => undefined,
  };
}

/**
 * The upload, as the zip it is or as a bare products sheet: anything not
 * starting `PK` as every zip does (an empty one too) is a CSV, and an XLSX is
 * a zip itself, one whose `[Content_Types].xml` sits beside no products file.
 */
async function openUpload(filePath: string): Promise<ZipFiles> {
  const handle = await open(filePath);
  const head = Buffer.alloc(2);
  try {
    await handle.read(head, 0, head.length, 0);
  } finally {
    await handle.close();
  }
  if (head.toString('latin1') !== 'PK') return sheetFiles(filePath);

  let reader: ZipReader;
  try {
    reader = await openZipReader(filePath, MAX_ARCHIVE_ENTRIES, { windowsNames: true });
  } catch (error) {
    throw zipRefusal(error);
  }
  const names = reader.entries.map((entry) => entry.name);
  if (
    names.includes('[Content_Types].xml') &&
    !names.some((name) => PRODUCT_SHEETS.test(baseName(name)))
  ) {
    reader.close();
    return sheetFiles(filePath);
  }
  return reader;
}

/**
 * One fixed file, found by its name wherever it sits, case aside; else, with
 * `names`, by a name an earlier version saved it under. Two of them is a
 * question only the person can answer.
 */
function findEntry(reader: ZipFiles, file: string, names?: RegExp): string | null {
  const files = reader.entries.filter((entry) => !entry.name.endsWith('/'));
  let hits = files.filter((entry) => baseName(entry.name).toLowerCase() === file);
  if (hits.length === 0 && names) hits = files.filter((entry) => names.test(baseName(entry.name)));
  if (hits.length > 1) throw new ValidationError('validation.productZip.manyFiles', { file });
  return hits[0]?.name ?? null;
}

async function entryBytes(
  reader: ZipFiles,
  name: string,
  maxBytes: number,
  tooLarge: MessageKey,
): Promise<Buffer> {
  if ((reader.entries.find((entry) => entry.name === name)?.bytes ?? 0) > maxBytes)
    throw new ValidationError(tooLarge);
  const chunks: Buffer[] = [];
  for await (const chunk of await reader.openStream(name)) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function sheetOf(
  reader: ZipFiles,
  name: string,
): Promise<{ bytes: Buffer; rows: string[][] }> {
  const bytes = await entryBytes(
    reader,
    name,
    MAX_PRODUCT_IMPORT_BYTES,
    'validation.import.tooLarge',
  );
  try {
    return { bytes, rows: await readSheetRows(bytes) };
  } catch {
    throw new ValidationError('validation.import.unreadable');
  }
}

const cell = (row: readonly string[], index: number): string =>
  index >= 0 ? (row[index] ?? '').trim() : '';

/**
 * A main product as a file asks for it. `brand` undefined leaves the brand as
 * it is; `order` undefined (no Order column) leaves its place, and null is none.
 */
interface MainRow {
  code: string | null;
  name: string;
  brand: string | null | undefined;
  order: number | null | undefined;
}

/** A `colours.csv` or `brands.csv` row. A field left undefined is a column the file lacks: that value stays. */
interface ListRow {
  value: string;
  label?: string;
  hex?: string | null;
  active: boolean;
}

/**
 * `colours.csv` or `brands.csv`, a value listed twice, case aside, read once:
 * the first row says it. A colours.csv with only Colour and Hex (an earlier
 * build's) reads as it always did: a blank hex leaves the colour's own, and
 * every colour it lists is switched on. One with no `column` is said and read
 * as no file (null): misread as listing nothing, it would take every value out.
 */
async function readList(
  reader: ZipFiles,
  entry: string,
  column: string,
  valueHeaders: readonly string[],
  problems: ProductZipProblem[],
): Promise<ListRow[] | null> {
  const { rows } = await sheetOf(reader, entry);
  const header = (rows[0] ?? []).map((text) => normalizeHeader(text ?? ''));
  const valueAt = header.findIndex((text) => valueHeaders.includes(text));
  if (valueAt === -1) {
    problems.push({
      subject: baseName(entry),
      messageKey: 'validation.import.missingColumn',
      params: { column },
    });
    return null;
  }
  const labelAt = header.indexOf('label');
  const hexAt = header.indexOf('hex');
  const activeAt = header.indexOf('active');
  const whole = labelAt !== -1 || activeAt !== -1;
  const list: ListRow[] = [];
  for (const row of rows.slice(1)) {
    const value = cell(row, valueAt);
    if (!value || list.some((listed) => listed.value.toLowerCase() === value.toLowerCase()))
      continue;
    const read: ListRow = {
      value,
      active: activeAt === -1 || !/^(no|n|false|0)$/i.test(cell(row, activeAt)),
    };
    // A blank label is the value's own, as the Fields screen saves one.
    if (labelAt !== -1) read.label = cell(row, labelAt) || value;
    const hex = cell(row, hexAt);
    if (hex && !HEX.test(hex))
      problems.push({
        subject: value,
        messageKey: 'validation.productZip.hexInvalid',
        params: { hex },
      });
    else if (hex || (whole && hexAt !== -1)) read.hex = hex || null;
    list.push(read);
  }
  return list;
}

/** One photo in `images/`, hashed on the way in. */
interface ZipPhoto {
  /** The file name the planner reads: `OPT-0001_2.jpg`, and `SW/101.jpg` for `SW%2F101.jpg`. */
  name: string;
  entry: string;
  head: Uint8Array;
  sha256: string;
}

interface ZipContents {
  productsCsv: Buffer;
  /** Every code `products.csv` names, lower-cased, a row with problems included. */
  fileCodes: Set<string>;
  mainProducts: MainRow[];
  /** Main products `products.csv` names by name alone, on a row with no main product code. */
  mainNames: Array<{ name: string; brand: string }>;
  /** Null for a zip without a `colours.csv` it can read (`readList`): the colour list stays as it is. */
  colours: ListRow[] | null;
  /** Null for a zip without a `brands.csv` it can read: the brands main products name are added as before (`registerBrands`). */
  brands: ListRow[] | null;
  photos: ZipPhoto[];
  /** A second file under the very same name, in another folder: never planned. */
  extraPhotos: string[];
  /** `photos.csv`: each photo's caption by its name as the planner keys it (`photoFileKey`). Null for a zip without one. */
  captions: Map<string, string> | null;
}

async function readZip(reader: ZipFiles, problems: ProductZipProblem[]): Promise<ZipContents> {
  const productsEntry = findEntry(reader, PRODUCTS_CSV, PRODUCT_SHEETS);
  if (!productsEntry) throw new ValidationError('validation.productZip.noProductsCsv');
  const products = await sheetOf(reader, productsEntry);

  // The header is checked here, before anything is written, with the import's own words.
  const headerAt = products.rows.findIndex((row) => !isBlankRow(row));
  if (headerAt === -1) throw new ValidationError('validation.import.emptyFile');
  const match = matchHeaders((products.rows[headerAt] ?? []).map((text) => text.trim()));
  if (match.missing.length > 0) {
    throw new ValidationError('validation.import.missingColumn', {
      column: labelOf(match.missing[0] as ImportField),
    });
  }
  const at = (field: ImportField): number =>
    match.byIndex.findIndex((column) => column?.field === field);

  const fileCodes = new Set<string>();
  // A main product products.csv names by a code main-products.csv does not list: its first row says what it is.
  const named: MainRow[] = [];
  const mainNames: ZipContents['mainNames'] = [];
  // Every row's own main product cells, to say where main-products.csv, the one read, disagrees.
  const cells: Array<{ code: string; name: string; brand: string }> = [];
  for (const row of products.rows.slice(headerAt + 1)) {
    if (isBlankRow(row)) continue;
    const code = cell(row, at('code'));
    if (code) fileCodes.add(code.toLowerCase());
    const mainCode = cell(row, at('categoryCode'));
    const name = cell(row, at('categoryName'));
    const brand = cell(row, at('categoryBrand'));
    if (!mainCode) {
      if (name) mainNames.push({ name, brand });
      continue;
    }
    cells.push({ code: mainCode.toLowerCase(), name, brand });
    if (!named.some((main) => main.code?.toLowerCase() === mainCode.toLowerCase())) {
      named.push({ code: mainCode, name, brand: brand || undefined, order: undefined });
    }
  }
  // A header and nothing else: refused here, before a main product is written, not by the import after.
  if (products.rows.slice(headerAt + 1).every(isBlankRow))
    throw new ValidationError('validation.import.emptyFile');

  const mainProducts: MainRow[] = [];
  // 1.2.5–1.4.6 saved it as main-products-2026-10-07.csv, with no Order column.
  const mainEntry = findEntry(reader, MAIN_PRODUCTS_CSV, MAIN_SHEETS);
  if (mainEntry) {
    const { rows } = await sheetOf(reader, mainEntry);
    const header = rows[0] ?? [];
    const mainMatch = matchHeaders(header);
    const mainAt = (field: ImportField): number =>
      mainMatch.byIndex.findIndex((column) => column?.field === field);
    const brandAt = mainAt('categoryBrand');
    const orderAt = header.findIndex((text) =>
      ['order', 'sortorder'].includes(normalizeHeader(text ?? '')),
    );
    for (const row of rows.slice(1)) {
      if (isBlankRow(row)) continue;
      const code = cell(row, mainAt('categoryCode')) || null;
      const name = cell(row, mainAt('categoryName'));
      // No Order column leaves every place as it is; an empty cell is no Order. Past what
      // the column holds (an INTEGER) is refused here, not by the write after the preview.
      const text = cell(row, orderAt);
      let order = orderAt === -1 ? undefined : text === '' ? null : Number(text);
      if (
        typeof order === 'number' &&
        !(Number.isInteger(order) && order >= 0 && order <= 2_147_483_647)
      ) {
        problems.push({ subject: code ?? name, messageKey: 'validation.category.sortOrder' });
        order = undefined;
      }
      mainProducts.push({
        code,
        name,
        // No Brand column leaves every brand as it is; an empty cell clears that one.
        brand: brandAt === -1 ? undefined : cell(row, brandAt) || null,
        order,
      });
    }

    const differs = (code: string, field: ImportField, value: string, listed: string): void => {
      problems.push({
        subject: code,
        messageKey: 'validation.productZip.mainDiffers',
        params: { column: labelOf(field), value, main: listed },
      });
    };
    const checked = new Set<string>();
    for (const main of mainProducts) {
      // A code listed again is not read at all (`planMainProducts` says so), so only its first row is compared.
      if (!main.code || checked.has(main.code.toLowerCase())) continue;
      checked.add(main.code.toLowerCase());
      const own = cells.filter((row) => row.code === main.code?.toLowerCase());
      const name = own.find((row) => row.name !== main.name);
      if (name && at('categoryName') !== -1)
        differs(main.code, 'categoryName', name.name, main.name);
      const listed = main.brand === undefined ? undefined : (main.brand ?? '').toLowerCase();
      const brand = own.find((row) => listed !== undefined && row.brand.toLowerCase() !== listed);
      if (brand && at('categoryBrand') !== -1)
        differs(main.code, 'categoryBrand', brand.brand, main.brand ?? '');
    }
  }
  for (const main of named) {
    if (!mainProducts.some((listed) => listed.code?.toLowerCase() === main.code?.toLowerCase()))
      mainProducts.push(main);
  }

  const colourEntry = findEntry(reader, COLOURS_CSV);
  const colours = colourEntry
    ? await readList(reader, colourEntry, 'Colour', ['colour', 'color'], problems)
    : null;
  const brandsEntry = findEntry(reader, BRANDS_CSV);
  const brands = brandsEntry
    ? await readList(reader, brandsEntry, 'Brand', ['brand'], problems)
    : null;

  let captions: ZipContents['captions'] = null;
  const captionsEntry = findEntry(reader, PHOTOS_CSV);
  if (captionsEntry) {
    const { rows } = await sheetOf(reader, captionsEntry);
    const header = (rows[0] ?? []).map((text) => normalizeHeader(text ?? ''));
    const fileAt = header.indexOf('file');
    const captionAt = header.indexOf('caption');
    captions = new Map();
    for (const row of rows.slice(1)) {
      // By name without its ending, as the planner reads a file: OPT-0001.jpg put in for OPT-0001.webp keeps its caption.
      const key = photoFileKey(fromFileSafe(cell(row, fileAt)))?.full;
      if (key && !captions.has(key)) captions.set(key, cell(row, captionAt));
    }
  }

  // Photos are the files in a folder named `images`, at any depth. Of the rest only a sheet is
  // looked at: one that is none of the files above was meant to be read, so it is said, not skipped.
  // What a Mac (`._name`) or a sheet open in Excel (`~$name`) leaves beside one is nobody's sheet.
  const sheets = new Set([productsEntry, mainEntry, colourEntry, brandsEntry, captionsEntry]);
  const photos: ZipPhoto[] = [];
  const extraPhotos: string[] = [];
  for (const { name: entry } of reader.entries) {
    if (sheets.has(entry) || entry.endsWith('/')) continue;
    if (
      !entry
        .split('/')
        .slice(0, -1)
        .some((folder) => folder.toLowerCase() === 'images')
    ) {
      const file = baseName(entry);
      if (/\.(csv|xlsx)$/i.test(file) && !/^(\._|~\$)/.test(file)) {
        problems.push({
          subject: file,
          messageKey: 'validation.productZip.unknownFile',
          params: { file },
        });
      }
      continue;
    }
    const name = fromFileSafe(baseName(entry));
    if (photos.some((photo) => photo.name === name)) {
      extraPhotos.push(name);
      continue;
    }
    const hash = createHash('sha256');
    let head = Buffer.alloc(0);
    for await (const chunk of await reader.openStream(entry)) {
      hash.update(chunk as Buffer);
      if (head.length < 16)
        head = Buffer.concat([head, (chunk as Buffer).subarray(0, 16 - head.length)]);
    }
    photos.push({ name, entry, head, sha256: hash.digest('hex') });
  }

  return {
    productsCsv: products.bytes,
    fileCodes,
    mainProducts,
    mainNames,
    colours,
    brands,
    photos,
    extraPhotos,
    captions,
  };
}

// --- Main products, colours and brands ---------------------------------------------

/** A main product as it stands, live or in the Recycle Bin. */
interface MainHeld {
  id: string;
  code: string | null;
  name: string;
  brand: string | null;
  sortOrder: number | null;
}

/** What the run does to one main product there already, through the ordinary edit. */
interface MainChange {
  id: string;
  /** How the report names it: its code before the run, else its name. */
  code: string;
  /** In the Recycle Bin: brought back first, as the Bin's own Restore does. */
  binned: boolean;
  was: MainHeld;
  final: { code: string | null; name: string; brand: string | null };
  patch: { name?: string; code?: string; brand?: string | null; sortOrder?: number | null };
  fields: ProductCellChange[];
}

interface MainPlan {
  added: productRepo.CategorySeed[];
  /** In an order the run can make them one by one: none takes a name or a code before its holder lets it go. */
  changed: MainChange[];
  /** Each main product there already that a row names, changed or not, and its brand after the run: never one the file leaves out. */
  listed: Map<string, string | null>;
}

const lower = (value: string | null | undefined): string => (value ?? '').toLowerCase();
/** What `idx_categories_brand_name` keeps unique. */
const nameKey = (main: { brand: string | null; name: string }): string =>
  `${lower(main.brand)}\u0000${lower(main.name)}`;

/** The main products in the Recycle Bin under these codes, the one binned last of each, by lower-cased code. */
async function binnedCategories(
  tenantId: string,
  codes: readonly string[],
): Promise<Map<string, MainHeld>> {
  const found = new Map<string, MainHeld>();
  if (codes.length === 0) return found;
  const rows = await db()('product_categories')
    .where({ tenant_id: tenantId })
    .whereNotNull('deleted_at')
    .whereRaw('lower(code) = ANY(?)', [codes.map(lower)])
    .orderBy('deleted_at', 'desc')
    .select<
      Array<{
        id: string;
        code: string;
        name: string;
        brand: string | null;
        sort_order: number | null;
      }>
    >('id', 'code', 'name', 'brand', 'sort_order');
  for (const row of rows) {
    if (!found.has(lower(row.code)))
      found.set(lower(row.code), {
        id: String(row.id),
        code: row.code,
        name: row.name,
        brand: row.brand,
        sortOrder: row.sort_order,
      });
  }
  return found;
}

/**
 * Which main products the zip adds, changes or brings back, read against the
 * live ones and against each other. A row is the live main product of its
 * code; else the one of its (brand, name), which takes the row's code; else
 * the one in the Recycle Bin under its code (for a person who may delete
 * products, as the Bin asks); else a new one, created where `ensureCategories`
 * finds nothing, so the preview and the run agree. A row whose code, or whose
 * (brand, name), a row before it already took is reported and not read. A
 * brand is spelled as the Brands list does once `brands` is written.
 *
 * With an Order column a main product's Order is the file's; without one (an
 * earlier version's file) one already there keeps its place, and a new one
 * goes after the last.
 */
async function planMainProducts(
  rows: readonly MainRow[],
  brands: ListPlan | null,
  actor: ActorContext,
  problems: ProductZipProblem[],
): Promise<MainPlan> {
  const { tenantId } = actor;
  const live = await productRepo.listCategories(tenantId);
  const brandByLower = new Map<string, string>();
  for (const category of live)
    if (category.brand) brandByLower.set(category.brand.toLowerCase(), category.brand);
  for (const option of await customFieldRepo.listOptionsForKey(tenantId, 'product.brand')) {
    brandByLower.set(option.value.toLowerCase(), option.value);
  }
  // A brand brands.csv adds or brings back from the Bin, as it does.
  for (const { row, hit } of brands?.writes ?? []) {
    const value = hit?.value ?? row.value;
    brandByLower.set(value.toLowerCase(), value);
  }
  const duplicate = (row: MainRow, first: MainRow): void => {
    problems.push({
      subject: row.code ?? row.name,
      messageKey: 'validation.productZip.mainDuplicate',
      params: { first: first.code ? `${first.code} — ${first.name}` : first.name },
    });
  };

  const plan: MainPlan = { added: [], changed: [], listed: new Map() };
  const read: MainRow[] = [];
  const byCode = new Map<string, MainRow>();
  for (const row of rows) {
    if (!row.name) {
      // Not read, and said; the main product of its code is still the file's, never one it leaves out.
      if (!row.code) continue;
      problems.push({ subject: row.code, messageKey: 'validation.category.nameRequired' });
      const hit = live.find((category) => lower(category.code) === lower(row.code));
      if (hit) plan.listed.set(hit.id, hit.brand);
      continue;
    }
    if (row.code && !CATEGORY_CODE_PATTERN.test(row.code)) {
      problems.push({
        subject: row.code,
        messageKey: 'validation.productZip.codeInvalid',
        params: { code: row.code },
      });
      continue;
    }
    const first = row.code ? byCode.get(lower(row.code)) : undefined;
    if (first) {
      duplicate(row, first);
      continue;
    }
    if (row.code) byCode.set(lower(row.code), row);
    read.push(row);
  }

  // By code first, every row: a row read by its name never takes the main product another names by code.
  const target = new Map<MainRow, MainHeld>();
  for (const row of read) {
    const hit = row.code
      ? live.find((category) => lower(category.code) === lower(row.code))
      : undefined;
    if (hit) target.set(row, hit);
  }
  const claimed = new Set([...target.values()].map((category) => category.id));
  const binned = await binnedCategories(
    tenantId,
    read.flatMap((row) => (row.code && !target.has(row) ? [row.code] : [])),
  );

  const taken = new Map<string, MainRow>();
  let last = Math.max(
    0,
    ...live.map((category) => category.sortOrder ?? 0),
    ...read.map((row) => row.order ?? 0),
  );
  for (const row of read) {
    const brand = row.brand ? (brandByLower.get(row.brand.toLowerCase()) ?? row.brand) : row.brand;
    let was = target.get(row);
    let inBin = false;
    let finalBrand = brand !== undefined ? brand : (was?.brand ?? null);
    if (!was) {
      const named = live.filter(
        (category) =>
          !claimed.has(category.id) &&
          lower(category.name) === lower(row.name) &&
          (!brand || lower(category.brand) === lower(brand)),
      );
      was =
        named.find((category) => !category.brand) ?? (named.length === 1 ? named[0] : undefined);
      // Brands share the name and the row names none: `ensureCategories` would add nothing.
      if (!was && named.length > 0) {
        for (const category of named) plan.listed.set(category.id, category.brand);
        continue;
      }
      if (was) {
        claimed.add(was.id);
        finalBrand = was.brand;
      } else if (row.code) {
        was = binned.get(lower(row.code));
        inBin = was !== undefined;
        if (was && brand === undefined) finalBrand = was.brand;
      }
    }
    if (was && inBin && !actorCan(actor, 'products.delete')) {
      problems.push({
        subject: row.code ?? row.name,
        messageKey: 'validation.import.binnedNeedsDelete',
        params: { name: was.name },
      });
      continue;
    }
    const final = {
      code: row.code ?? was?.code ?? null,
      name: row.name,
      brand: finalBrand ?? null,
    };
    // Named by the file even when this row is not read: its sub products may still be filed under it.
    if (was) plan.listed.set(was.id, was.brand);
    const first = taken.get(nameKey(final));
    if (first) {
      duplicate(row, first);
      continue;
    }
    taken.set(nameKey(final), row);
    if (was) plan.listed.set(was.id, final.brand);

    const order = row.order !== undefined ? row.order : was ? undefined : (last += 1);
    if (!was) {
      plan.added.push({
        code: row.code,
        name: row.name,
        brand: final.brand,
        sortOrder: order ?? null,
      });
      continue;
    }
    const patch: MainChange['patch'] = {};
    const fields: ProductCellChange[] = [];
    if (final.name !== was.name) {
      patch.name = final.name;
      fields.push({ column: labelOf('categoryName'), from: was.name, to: final.name });
    }
    if (lower(final.code) !== lower(was.code)) {
      patch.code = final.code as string;
      fields.push({ column: labelOf('categoryCode'), from: was.code ?? '', to: final.code ?? '' });
    }
    if (final.brand !== was.brand) {
      patch.brand = final.brand;
      fields.push({
        column: labelOf('categoryBrand'),
        from: was.brand ?? '',
        to: final.brand ?? '',
      });
    }
    if (order !== undefined && order !== was.sortOrder) {
      patch.sortOrder = order;
      fields.push({ column: 'Order', from: String(was.sortOrder ?? ''), to: String(order ?? '') });
    }
    if (inBin || fields.length > 0)
      plan.changed.push({
        id: was.id,
        code: was.code ?? was.name,
        binned: inBin,
        was,
        final,
        patch,
        fields,
      });
  }

  // One by one, as the run makes them: a change waits until the name and code it takes are let
  // go. One that never is (two that swap names, or one a main product the file leaves as it is
  // holds) clashes, in the preview as in the run. New ones go in last, into what is left.
  const names = new Map(live.map((category) => [nameKey(category), category.id]));
  const codes = new Map(
    live.flatMap((category) =>
      category.code ? [[lower(category.code), category.id] as const] : [],
    ),
  );
  const free = (held: Map<string, string>, key: string, id: string): boolean =>
    (held.get(key) ?? id) === id;
  // One from the Bin comes back under its old brand (`restoreCategory`) before it takes the file's.
  const backFree = (change: MainChange): boolean =>
    !change.binned ||
    free(names, nameKey({ brand: change.was.brand, name: change.final.name }), change.id);
  let waiting = plan.changed;
  plan.changed = [];
  for (let moved = true; moved;) {
    moved = false;
    waiting = waiting.filter((change) => {
      const code = lower(change.final.code);
      if (
        !free(names, nameKey(change.final), change.id) ||
        (code && !free(codes, code, change.id)) ||
        !backFree(change)
      )
        return true;
      if (!change.binned) {
        names.delete(nameKey(change.was));
        codes.delete(lower(change.was.code));
      }
      names.set(nameKey(change.final), change.id);
      if (code) codes.set(code, change.id);
      plan.changed.push(change);
      moved = true;
      return false;
    });
  }
  for (const change of waiting) {
    const code = lower(change.final.code);
    problems.push(
      !free(names, nameKey(change.final), change.id)
        ? {
            subject: change.code,
            messageKey: 'error.conflict.categoryNameTaken',
            params: { name: change.final.name },
          }
        : code && !free(codes, code, change.id)
          ? {
              subject: change.code,
              messageKey: 'error.conflict.categoryCodeTaken',
              params: { code: change.final.code ?? '' },
            }
          : {
              subject: change.code,
              messageKey: 'error.conflict.restoreCollision',
              params: { field: 'name' },
            },
    );
  }
  // A new one with no brand would be filed under any main product of its name: `ensureCategories`
  // reads the ones there before it, not the other new ones, which were told apart above.
  const held = (seed: productRepo.CategorySeed): boolean =>
    seed.brand
      ? names.has(nameKey({ brand: seed.brand, name: seed.name }))
      : [...names.keys()].some((key) => key.endsWith(`\u0000${lower(seed.name)}`));
  plan.added = plan.added.filter((seed) => {
    if (!held(seed)) return true;
    problems.push({
      subject: seed.code ?? seed.name,
      messageKey: 'error.conflict.categoryNameTaken',
      params: { name: seed.name },
    });
    return false;
  });
  return plan;
}

function problemOf(subject: string, error: unknown): ProductZipProblem {
  return error instanceof AppError
    ? { subject, messageKey: error.messageKey, params: error.params }
    : {
        subject,
        messageKey: 'validation.import.rowFailed',
        params: { reason: toErrorMessage(error) },
      };
}

/**
 * The plan, through the ordinary edits (their checks, their events): the
 * Brands list first, so every brand a main product takes is listed; then each
 * change in the plan's order, one in the Recycle Bin brought back as the Bin's
 * own Restore does; then the new ones, into the names the changes let go. A
 * refusal is reported, never thrown. Answers what went through.
 */
async function applyMainProducts(
  plan: MainPlan,
  brands: ListPlan | null,
  actor: ActorContext,
  problems: ProductZipProblem[],
): Promise<MainPlan> {
  const { tenantId } = actor;
  await db().transaction(async (trx) => {
    if (brands) await writeList(tenantId, brands, trx);
    await registerBrands(
      tenantId,
      [...plan.added, ...plan.changed.map((change) => change.final)].map(
        (main) => main.brand ?? '',
      ),
      await customFieldRepo.listOptionsForKey(tenantId, 'product.brand', {}, trx),
      trx,
    );
  });
  customFieldRepo.invalidateFieldCache(tenantId);

  const changed: MainChange[] = [];
  for (const change of plan.changed) {
    try {
      if (change.binned) await catalog.restoreCategory(change.id, actor, change.patch.name);
      // The backup's brand, switched off in the list or not, as a new one is created with it.
      if (Object.keys(change.patch).length > 0)
        await catalog.updateCategory(change.id, change.patch, actor, { switchedOffBrand: true });
      changed.push(change);
    } catch (error) {
      problems.push(problemOf(change.code, error));
    }
  }
  try {
    await db().transaction((trx) => productRepo.ensureCategories(tenantId, plan.added, trx));
    return { ...plan, changed };
  } catch (error) {
    // The plan checked them; a clash only the write meets (a screen saving the same name) is said, not thrown.
    for (const seed of plan.added) problems.push(problemOf(seed.code ?? seed.name, error));
    return { ...plan, added: [], changed };
  }
}

const yesNo = (active: boolean): string => (active ? 'yes' : 'no');

/** What `colours.csv` or `brands.csv` does to its list, and the writes that do exactly that. */
interface ListPlan {
  listKey: string;
  report: ProductZipList;
  /** Each row that changes the list: a value it adds (no `hit`), or the one it matched, in the Bin or not. */
  writes: Array<{ row: ListRow; hit?: OptionListItem }>;
  /** The whole list in its new order, when the file reorders it: an id, or a value the run adds. */
  order: Array<{ id?: string; value: string }> | null;
  /** The last sequence in use: a value added takes the next. */
  sequence: number;
  /** The live values the file does not list: what `exactCatalogue` takes out. */
  gone: OptionListItem[];
}

/**
 * The file is the truth for each value it lists: one the list lacks is added,
 * out of the Recycle Bin if it is there; one it has, matched case aside (its
 * own spelling kept, an exact one first where the list holds two), takes the
 * file's label, hex and Active. When the values it lists stand in another
 * order than the list's, the list is numbered in the file's, the ones it does
 * not list after them. A value the file leaves out stays as it is.
 */
async function planList(
  tenantId: string,
  listKey: string,
  rows: readonly ListRow[],
): Promise<ListPlan> {
  const existing = await customFieldRepo.listOptionsForKey(tenantId, listKey, {
    includeDeleted: true,
  });
  const live = existing.filter((option) => !option.deletedAt);
  const find = (value: string): OptionListItem | undefined => {
    const matches = (pool: readonly OptionListItem[]) =>
      pool.find((option) => option.value === value) ??
      pool.find((option) => option.value.toLowerCase() === value.toLowerCase());
    return matches(live) ?? matches(existing.filter((option) => option.deletedAt));
  };
  const sequence = Math.max(0, ...existing.map((option) => option.sequence));
  const plan: ListPlan = {
    listKey,
    report: { added: [], changed: [] },
    writes: [],
    order: null,
    sequence,
    gone: [],
  };

  // Where each value the file lists stands once written: its place in the list, an added one
  // after the end. A place, not its sequence: two values may share one.
  let next = existing.length;
  const listed: Array<{ id?: string; value: string; at: number }> = [];
  for (const row of rows) {
    const hit = find(row.value);
    listed.push({ id: hit?.id, value: row.value, at: hit ? existing.indexOf(hit) : next++ });
    if (!hit || hit.deletedAt) plan.report.added.push(hit?.value ?? row.value);
    const fields: ProductCellChange[] = [];
    if (hit) {
      const change = (column: string, from: string, to: string): void => {
        fields.push({ column: `${hit.value} — ${column}`, from, to });
      };
      if (row.label !== undefined && row.label !== hit.label) change('Label', hit.label, row.label);
      // A hex is the same colour in either case: the shipped list writes #FEFEFE, the Fields screen #fefefe.
      if (row.hex !== undefined && lower(row.hex) !== lower(hit.hex))
        change('Hex', hit.hex ?? '', row.hex ?? '');
      if (row.active !== hit.isActive) change('Active', yesNo(hit.isActive), yesNo(row.active));
      if (!hit.deletedAt) plan.report.changed.push(...fields);
    }
    if (!hit || hit.deletedAt || fields.length > 0) plan.writes.push({ row, hit });
  }
  const ids = new Set(listed.map((entry) => entry.id));
  plan.gone = live.filter((option) => !ids.has(option.id));
  if (listed.some((entry, index) => index > 0 && entry.at <= (listed[index - 1]?.at ?? 0))) {
    plan.order = [...listed, ...plan.gone];
    plan.report.reordered = true;
  }
  return plan;
}

async function writeList(tenantId: string, plan: ListPlan, trx: TransactionContext): Promise<void> {
  let sequence = plan.sequence;
  const added = new Map<string, string>();
  for (const { row, hit } of plan.writes) {
    let id = hit?.id;
    if (!id) {
      id = await customFieldRepo.insertOption(
        {
          tenantId,
          listKey: plan.listKey,
          value: row.value,
          label: row.label ?? row.value,
          hex: row.hex ?? null,
          sequence: (sequence += 1),
          createdBy: null,
        },
        trx,
      );
      added.set(row.value, id);
      // Inserted switched on.
      if (row.active) continue;
    } else if (hit?.deletedAt) {
      await customFieldRepo.restoreOption(tenantId, id, trx);
    }
    await customFieldRepo.updateOptionColumns(
      tenantId,
      id,
      { label: row.label, hex: row.hex, isActive: row.active, updatedBy: null },
      trx,
    );
  }
  if (plan.order)
    await customFieldRepo.reorderOptions(
      tenantId,
      plan.order.map((entry, index) => ({
        id: entry.id ?? (added.get(entry.value) as string),
        sequence: index + 1,
      })),
      trx,
    );
}

/** Anything a list plan writes. */
const listChanges = (plan: ListPlan | null): number =>
  plan
    ? plan.report.added.length + plan.report.changed.length + Number(plan.report.reordered === true)
    : 0;

// --- Photos ------------------------------------------------------------------------

interface PhotoPlan {
  report: ProductZipReport['photos'];
  /** What the run uploads: new photos and replaced ones, never an unchanged one. */
  toRun: PhotoPlanRow<ZipPhoto>[];
  /** The zip's slot of each photo it keeps as it is, by image id. */
  keptSlots: Map<string, number>;
  /** Each sub product the zip keeps a photo of, by id: the run puts its gallery in the zip's order. */
  kept: Set<string>;
  /** Kept sub products whose main photo or order differs from the zip's: their first live code, by id. */
  reordered: Map<string, string>;
  /** Kept photos whose caption `photos.csv` gives otherwise. */
  recaption: Array<{ imageId: string; caption: string | null; name: string }>;
  /** Photos of the file's sub products that no file names. */
  notInZip: Array<{ imageId: string; name: string }>;
}

/**
 * A gallery (ids, in order) as the zip orders it: the photos it names at their
 * slots, the others after them in their own order. The zip's photo 1 is the
 * primary, which only `isPrimary` moves; with none named, the primary stays.
 */
function zipOrder(gallery: readonly string[], slots: ReadonlyMap<string, number>): string[] {
  const place = (id: string): number => slots.get(id) ?? 1_000_000 + gallery.indexOf(id);
  const sorted = [...gallery].sort((a, b) => place(a) - place(b));
  const first = sorted[0] !== undefined && slots.get(sorted[0]) === 1 ? sorted[0] : gallery[0];
  return first === undefined ? [] : [first, ...sorted.filter((id) => id !== first)];
}

const sameOrder = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, index) => id === b[index]);

/**
 * Each file is matched by its bytes first, against every photo of its sub
 * product: the master's checksum, or `sourceOf`, each photo's
 * `source_checksum` by image id. A match is unchanged and kept, at the zip's
 * slot, whatever slot it holds now, so a photo that moved up when an earlier
 * one was deleted, or one a second colour code names, is never uploaded again
 * or removed. Only a file no photo matches is compared by slot: an empty slot,
 * or one whose photo another file keeps or replaces, adds it beside; any other
 * replaces that one photo. A kept sub product whose main photo or order the
 * zip's differs from is listed, as the run puts it back.
 *
 * `keepPhotos`: a photo already in a slot stays, whatever its bytes. The boot
 * load asks for it: it only ever fills an empty catalogue, so a photo there is
 * one an interrupted load already put in (its source hash matches anyway), or
 * one the shipped catalogue photos or a person put in while it was stopped.
 */
async function planPhotos(
  zip: ZipContents,
  products: readonly Product[],
  sourceOf: ReadonlyMap<string, string>,
  tenantId: string,
  keepPhotos = false,
): Promise<PhotoPlan> {
  const byId = new Map(products.map((product) => [product.id, product]));
  const report: ProductZipReport['photos'] = {
    added: [],
    replaced: [],
    unchanged: 0,
    recaptioned: [],
    reordered: [],
    unmatched: [],
    duplicate: [...zip.extraPhotos],
    notImage: [],
    notInZip: [],
  };
  const toRun: PhotoPlanRow<ZipPhoto>[] = [];
  const keptSlots = new Map<string, number>();
  const kept = new Set<string>();
  const recaption: PhotoPlan['recaption'] = [];
  // Every photo a row keeps or replaces: no other row may touch it.
  const claimed = new Set<string>();
  const keep = (row: PhotoPlanRow<ZipPhoto>, product: Product, imageId: string): void => {
    report.unchanged += 1;
    claimed.add(imageId);
    keptSlots.set(imageId, row.slot ?? 1);
    kept.add(product.id);
  };
  // The caption photos.csv gives a file it lists; undefined leaves the planner's (a colour's label).
  const captionOf = (file: ZipPhoto): string | null | undefined => {
    const caption = zip.captions?.get(photoFileKey(file.name)?.full ?? '');
    return caption === undefined ? undefined : caption || null;
  };

  let unmatched: Array<{ row: PhotoPlanRow<ZipPhoto>; product: Product }> = [];
  for (const row of planPhotoImport(zip.photos, products)) {
    if (row.status === 'unmatched') report.unmatched.push(row.fileName);
    else if (row.status === 'duplicate') report.duplicate.push(row.fileName);
    else if (row.status === 'notImage') report.notImage.push(row.fileName);
    else unmatched.push({ row, product: byId.get(row.productId as string) as Product });
  }
  // Its own slot's photo first, then any photo's master, then any photo's source: the planner
  // takes OPT-0001_2 before OPT-0001, and the same picture twice, or a photo made from another's
  // master, must not let one file take the photo the other is the very bytes of.
  const passes: Array<(row: PhotoPlanRow<ZipPhoto>, image: ProductImage) => boolean> = [
    (row, image) =>
      image.id === row.slotImageId &&
      (image.checksum === row.file.sha256 || sourceOf.get(image.id) === row.file.sha256),
    (row, image) => image.checksum === row.file.sha256,
    (row, image) => sourceOf.get(image.id) === row.file.sha256,
  ];
  for (const pass of passes) {
    unmatched = unmatched.filter(({ row, product }) => {
      const image = product.images.find(
        (candidate) => !claimed.has(candidate.id) && pass(row, candidate),
      );
      if (!image) return true;
      keep(row, product, image.id);
      const caption = captionOf(row.file);
      if (caption !== undefined && caption !== image.caption)
        recaption.push({ imageId: image.id, caption, name: row.fileName });
      return false;
    });
  }
  for (const { row, product } of unmatched) {
    const caption = captionOf(row.file);
    const upload = { ...row, caption: caption === undefined ? row.caption : caption };
    if (row.slotImageId && !claimed.has(row.slotImageId)) {
      if (keepPhotos) {
        keep(row, product, row.slotImageId);
        continue;
      }
      claimed.add(row.slotImageId);
      report.replaced.push(row.fileName);
      toRun.push(upload);
    } else {
      report.added.push(row.fileName);
      toRun.push({ ...upload, status: 'new', slotImageId: undefined });
    }
  }
  report.recaptioned = recaption.map((photo) => photo.name);

  // The photos a replacement removes are gone by then; an upload is listed already.
  const leaving = new Set(toRun.map((row) => row.slotImageId));
  const reordered = new Map<string, string>();
  for (const productId of kept) {
    const product = byId.get(productId) as Product;
    const gallery = galleryOrder(product).filter((id) => !leaving.has(id));
    if (!sameOrder(zipOrder(gallery, keptSlots), gallery))
      reordered.set(
        productId,
        product.variants.find((variant) => variant.isActive)?.code ?? product.name,
      );
  }
  report.reordered = [...reordered.values()];

  const codes = codesOf(products);
  const notInZip: PhotoPlan['notInZip'] = [];
  // A file with no photo at all (a products sheet from 1.2.4–1.4.6, a zip of products.csv
  // alone) says nothing about photos, as one without colours.csv says nothing about colours:
  // none is missing from it, so neither opt-in can take a photo out.
  if (zip.photos.length === 0) report.noFile = true;
  for (const product of zip.photos.length === 0 ? [] : products) {
    if (!product.variants.some((variant) => zip.fileCodes.has(variant.code.toLowerCase())))
      continue;
    const gallery = galleryImages(product);
    // Named by the slot it holds after the run: behind every photo the zip puts in.
    let slot =
      gallery.filter((image) => keptSlots.has(image.id)).length +
      toRun.filter((row) => row.productId === product.id).length;
    for (const image of gallery) {
      if (claimed.has(image.id)) continue;
      slot += 1;
      // A photo with no name to go under is in no zip, so never missing from one (the README lists
      // it); nor is one whose files are gone here, which the boot heal may still bring back.
      const name = photoBaseName(product, image, slot, codes);
      if (name !== null && (await exists(masterFile(tenantId, image.id))))
        notInZip.push({ imageId: image.id, name });
    }
  }
  report.notInZip = notInZip.map((photo) => photo.name);
  return { report, toRun, keptSlots, kept, reordered, recaption, notInZip };
}

/**
 * Upload the plan through the ordinary pipeline, "replace" as the photo import
 * runs it (new photo in first, a new photo 1 made primary, then the old one
 * out), give the kept photos the captions `photos.csv` does, then put each sub
 * product's gallery in the zip's order: an upload lands last, so a replaced
 * photo 2 would otherwise come back as photo 3, and a kept photo may hold
 * another slot than the zip's.
 */
async function runPhotos(
  reader: ZipFiles,
  plan: PhotoPlan,
  actor: ActorContext,
  problems: ProductZipProblem[],
  progress: (done: number, total: number) => void,
): Promise<{ added: string[]; replaced: string[]; recaptioned: string[]; reordered: string[] }> {
  const slots = new Map(plan.keptSlots);
  const refusals = new Map<ZipPhoto, ProductZipProblem>();

  const outcomes = await runPhotoImport(plan.toRun, 'replace', {
    upload: async (productId, file, caption) => {
      try {
        const bytes = await entryBytes(
          reader,
          file.entry,
          MAX_IMAGE_SOURCE_BYTES,
          'validation.image.tooLarge',
        );
        const product = await uploadImage(
          {
            productId,
            fileBuffer: bytes,
            crop: { cropX: 0, cropY: 0, cropWidth: 0, cropHeight: 0, rotationDeg: 0, caption },
            wholeFrame: true,
          },
          actor,
        );
        const id = newestImageId(product);
        const row = plan.toRun.find((candidate) => candidate.file === file);
        if (id) slots.set(id, row?.slot ?? 1);
        return id;
      } catch (error) {
        refusals.set(file, problemOf(file.name, error));
        throw error;
      }
    },
    removeImage: (_productId, imageId) => deleteImage(imageId, actor),
    setPrimary: (_productId, imageId) => updateImageCaption(imageId, { isPrimary: true }, actor),
    // The service is called directly, never through the HTTP rate limit.
    retryAfterMs: () => null,
    errorText: toErrorMessage,
    onProgress: progress,
  });

  const landed = {
    added: [] as string[],
    replaced: [] as string[],
    recaptioned: [] as string[],
    reordered: [] as string[],
  };
  const touched = new Set<string>();
  for (const outcome of outcomes) {
    if (outcome.result === 'imported') {
      (outcome.row.status === 'new' ? landed.added : landed.replaced).push(outcome.row.fileName);
      touched.add(outcome.row.productId as string);
      if (outcome.error)
        problems.push({
          subject: outcome.row.fileName,
          messageKey: 'productZip.problem.photo',
          params: { reason: outcome.error },
        });
    } else if (outcome.result === 'failed') {
      problems.push(
        refusals.get(outcome.row.file) ?? {
          subject: outcome.row.fileName,
          messageKey: 'productZip.problem.photo',
          params: { reason: outcome.error ?? '' },
        },
      );
    }
  }

  for (const { imageId, caption, name } of plan.recaption) {
    try {
      await updateImageCaption(imageId, { caption }, actor);
      landed.recaptioned.push(name);
    } catch (error) {
      problems.push(problemOf(name, error));
    }
  }

  // Read again, every one: a photo added or deleted on the screens while the restore ran is in
  // the gallery reordered, or `reorderImages` refuses the set after the primary already moved.
  for (const productId of new Set([...touched, ...plan.kept])) {
    const product = await productRepo.findProductById(actor.tenantId, productId);
    if (!product) continue;
    const gallery = galleryOrder(product);
    const wanted = zipOrder(gallery, slots);
    if (sameOrder(wanted, gallery)) continue;
    try {
      if (wanted[0] !== gallery[0])
        await updateImageCaption(wanted[0] as string, { isPrimary: true }, actor);
      await reorderImages({ productId, ids: wanted }, actor);
      const name = plan.reordered.get(productId);
      if (name !== undefined) landed.reordered.push(name);
    } catch (error) {
      problems.push(problemOf(product.name, error));
    }
  }
  return landed;
}

// --- The run ---------------------------------------------------------------------------

type Progress = (progress: Partial<Pick<ProductRestoreJob, 'phase' | 'done' | 'total'>>) => void;

function requireRestorePermissions(actor: ActorContext, options: ProductRestoreOptions): void {
  requirePermission(actor, 'products.bulk');
  requirePermission(actor, 'products.create');
  requirePermission(actor, 'products.edit');
  if (options.binMissingProducts || options.exactCatalogue)
    requirePermission(actor, 'products.delete');
}

/** `keepPhotos` is the boot load's alone (`planPhotos`); no request can ask for it. */
type RunOptions = ProductRestoreOptions & { keepPhotos?: boolean };

/** The brand values none of these brands is, case aside. */
function unusedBrands(
  options: readonly OptionListItem[],
  brands: Iterable<string | null>,
): OptionListItem[] {
  const used = new Set([...brands].map(lower));
  return options.filter((option) => !used.has(lower(option.value)));
}

/** `{ [key]: list }`, or nothing for an empty list: the report leaves out a list with nothing in it. */
const ifAny = <K extends string, T>(key: K, list: readonly T[]): Partial<Record<K, T[]>> =>
  (list.length > 0 ? { [key]: [...list] } : {}) as Partial<Record<K, T[]>>;

async function runZip(
  filePath: string,
  fileName: string,
  options: RunOptions & { dryRun: boolean },
  actor: ActorContext,
  progress: Progress = () => undefined,
): Promise<ProductZipReport> {
  requireRestorePermissions(actor, options);
  const { tenantId } = actor;
  const { dryRun } = options;
  // The catalogue made exactly the file: both removals, and every other thing the file does not list.
  const exact = options.exactCatalogue === true;
  const problems: ProductZipProblem[] = [];

  const reader = await openUpload(filePath);
  try {
    progress({ phase: 'checking' });
    const zip = await readZip(reader, problems).catch((error: unknown) => {
      throw zipRefusal(error);
    });

    const brands = zip.brands && (await planList(tenantId, 'product.brand', zip.brands));
    const planned = await planMainProducts(zip.mainProducts, brands, actor, problems);
    const colours = zip.colours && (await planList(tenantId, 'stock.colour', zip.colours));
    // As they stand before anything is written: what the exact catalogue can take out.
    const mainsBefore = await productRepo.listCategories(tenantId);
    const brandsBefore = brands
      ? []
      : await customFieldRepo.listOptionsForKey(tenantId, 'product.brand');
    const filedBrands = [
      ...planned.listed.values(),
      ...planned.added.map((seed) => seed.brand ?? null),
      // A main product products.csv names by name alone is filed under its row's brand.
      ...zip.mainNames.map((row) => row.brand || null),
    ];
    // A colour goes to the Recycle Bin for a person who may delete one; for anyone else it is
    // switched off, as the restore may already do to a colour the file lists.
    const binColours = actorCan(actor, 'fields.manage');
    const coloursGone = (colours?.gone ?? []).filter((option) => binColours || option.isActive);
    // Changing the colour or brand list is the lists' own permission, asked before anything is
    // written: under `exactCatalogue` for every value it may take out too, which a preview
    // tells a person without it.
    const mayTakeOut =
      coloursGone.length +
      (brands ? brands.gone.length : unusedBrands(brandsBefore, filedBrands).length);
    if (listChanges(colours) + listChanges(brands) + (exact ? mayTakeOut : 0) > 0)
      requirePermission(actor, 'catalog.lists.manage');
    const exactNeedsLists = mayTakeOut > 0 && !actorCan(actor, 'catalog.lists.manage');

    let main = planned;
    if (!dryRun) {
      // The first write: from here on the catalogue is the company's own, and the shipped photos
      // never come back on a later boot. A run refused before this only stopped them.
      if (!options.keepPhotos) await retireCataloguePhotos();
      progress({ phase: 'products' });
      main = await applyMainProducts(planned, brands, actor, problems);
      // The colours after the main products, in one transaction: nothing is half written before a refusal there.
      if (colours && listChanges(colours) > 0) {
        await db().transaction((trx) => writeList(tenantId, colours, trx));
        customFieldRepo.invalidateFieldCache(tenantId);
      }
    }

    // A dry run reads the main products the run creates, recodes or brings back from the Bin as it leaves them.
    const { rows, ...imported } = await importProducts(
      { buffer: zip.productsCsv, fileName: PRODUCTS_CSV },
      {
        dryRun,
        mode: 'upsert',
        restore: {
          ...(dryRun
            ? {
                pendingCategories: planned.added,
                plannedCategories: planned.changed.map((change) => ({
                  id: change.id,
                  ...change.final,
                })),
              }
            : {}),
          exactVariants: exact,
        },
      },
      actor,
    );
    const added = rows?.added ?? [];
    // Every sub product a row read, by its codes or (another install's codes) by its name: none is missing.
    const matched = new Set(rows?.matchedIds ?? []);

    const live = (await productRepo.listProducts(tenantId, { limit: 100_000, offset: 0 })).items;
    const missing = live.filter((product) => {
      const codes = product.variants
        .filter((variant) => variant.isActive)
        .map((variant) => variant.code.toLowerCase());
      return (
        codes.length > 0 &&
        !matched.has(product.id) &&
        !codes.some((code) => zip.fileCodes.has(code))
      );
    });

    // What `exactCatalogue` takes out besides, the same for the preview and the run. A main product
    // neither file names goes once its sub products have: kept only by one the file names but whose
    // row was refused, which stays where it is. A brand goes when brands.csv leaves it out, or, with
    // none, when no main product left has it.
    const leaving = new Set(missing.map((product) => product.id));
    const holding = new Set(
      live
        .filter((product) => !leaving.has(product.id) && !matched.has(product.id))
        .map((product) => product.categoryId),
    );
    const namedByName = (main: { name: string; brand: string | null }): boolean =>
      zip.mainNames.some(
        (row) =>
          lower(row.name) === lower(main.name) &&
          (!row.brand || lower(row.brand) === lower(main.brand)),
      );
    const unlisted = mainsBefore.filter((main) => !planned.listed.has(main.id));
    const mainGone = unlisted.filter((main) => !holding.has(main.id) && !namedByName(main));
    const brandsGone = brands
      ? brands.gone
      : unusedBrands(brandsBefore, [
          ...filedBrands,
          ...unlisted.filter((main) => !mainGone.includes(main)).map((main) => main.brand),
        ]);

    // A dry run plans photos against the sub products as the import leaves them
    // (`rows.subProducts`): a new one, one back from the Bin, one a code is added to.
    // So does the exact run, with the codes `exactVariants` removed, as its preview
    // read them: a photo the zip names by one is kept or replaced, never removed
    // unlisted. The planner reads only their id, codes and gallery.
    let products = live;
    if (dryRun || exact) {
      // The run's new ones are live already.
      const subs = (rows?.subProducts ?? []).filter((sub) => dryRun || sub.id);
      const held = new Map(live.map((product) => [product.id, product]));
      const binned = subs.flatMap((sub) => (sub.id && !held.has(sub.id) ? [sub.id] : []));
      for (const [id, product] of await productRepo.findProductsByIds(tenantId, binned))
        held.set(id, product);
      const changing = new Set(subs.map((sub) => sub.id));
      products = [
        ...live.filter((product) => !changing.has(product.id)),
        ...subs.map(
          (sub, index) =>
            ({
              ...(held.get(sub.id ?? '') ?? { id: `pending:${index}`, alias: null, images: [] }),
              name: sub.name,
              hasVariants: sub.hasVariants,
              variants: sub.variants.map((variant) => ({ ...variant, isActive: true })),
            }) as unknown as Product,
        ),
      ];
    }
    const photoPlan = await planPhotos(
      zip,
      products,
      await imageRepo.sourceChecksumsForTenant(tenantId),
      tenantId,
      options.keepPhotos,
    );
    const photos = photoPlan.report;

    const restored = main.changed
      .filter((change) => change.binned)
      .map((change) => ({
        code: change.final.code ?? '',
        name: change.final.name,
        brand: change.final.brand,
      }));
    const report: ProductZipReport = {
      dryRun,
      fileName,
      mainProducts: {
        added: main.added.map((seed) => ({
          code: seed.code ?? '',
          name: seed.name,
          brand: seed.brand ?? null,
        })),
        renamed: main.changed
          .filter((change) => change.fields.length > 0)
          .map((change) => ({ code: change.code, fields: change.fields })),
        ...ifAny('restoredFromBin', restored),
        ...ifAny(
          'notInFile',
          mainGone.map((gone) => ({ code: gone.code ?? '', name: gone.name, brand: gone.brand })),
        ),
      },
      products: imported,
      rows: {
        added,
        changed: rows?.changed ?? [],
        notInFile: missing.map((product) => ({
          code: product.variants.find((variant) => variant.isActive)?.code ?? '',
          name: product.name,
        })),
        ...ifAny('variantsNotInFile', rows?.variantsNotInFile ?? []),
        ...ifAny('restoredFromBin', rows?.restoredFromBin ?? []),
        ...ifAny('reordered', rows?.reordered ?? []),
      },
      colours: colours
        ? {
            ...colours.report,
            ...ifAny(
              'notInFile',
              coloursGone.map((option) => option.value),
            ),
            ...(coloursGone.length > 0 && !binColours ? { switchedOff: true } : {}),
          }
        : { added: [], changed: [], noFile: true },
      brands: {
        ...(brands?.report ?? { added: [], changed: [] }),
        ...ifAny(
          'notInFile',
          brandsGone.map((option) => option.value),
        ),
      },
      photos,
      ...(dryRun && exactNeedsLists ? { exactNeedsLists } : {}),
      problems,
    };
    if (dryRun) return report;

    progress({ phase: 'photos', done: 0, total: photoPlan.toRun.length });
    const landed = await runPhotos(reader, photoPlan, actor, problems, (done, total) =>
      progress({ done, total }),
    );
    photos.added = landed.added;
    photos.replaced = landed.replaced;
    photos.recaptioned = landed.recaptioned;
    photos.reordered = landed.reordered;

    progress({ phase: 'removing', done: 0, total: 0 });
    let binned = 0;
    if (options.binMissingProducts || exact) {
      for (const product of missing) {
        try {
          await catalog.deleteProduct(product.id, actor);
          binned += 1;
        } catch (error) {
          problems.push(problemOf(product.variants[0]?.code ?? product.name, error));
        }
      }
    }
    // After the sub products: a main product with one left is refused, and said.
    const removed = { mainProducts: 0, colours: 0, brands: 0 };
    if (exact) {
      for (const gone of mainGone) {
        try {
          await catalog.deleteCategory(gone.id, actor);
          removed.mainProducts += 1;
        } catch (error) {
          problems.push(problemOf(gone.code ?? gone.name, error));
        }
      }
      const binValues = async (values: readonly OptionListItem[], list: 'colours' | 'brands') => {
        for (const option of values) {
          try {
            await fields.deleteValue(option.id, actor);
            removed[list] += 1;
          } catch (error) {
            problems.push(problemOf(option.value, error));
          }
        }
      };
      await binValues(brandsGone, 'brands');
      if (binColours) await binValues(coloursGone, 'colours');
      else if (coloursGone.length > 0) {
        await db().transaction(async (trx) => {
          for (const option of coloursGone)
            await customFieldRepo.updateOptionColumns(
              tenantId,
              option.id,
              { isActive: false, updatedBy: null },
              trx,
            );
        });
        customFieldRepo.invalidateFieldCache(tenantId);
        removed.colours = coloursGone.length;
      }
      report.exactRemoved = removed;
    }
    let photosRemoved = 0;
    if (options.removeMissingPhotos || exact) {
      for (const photo of photoPlan.notInZip) {
        try {
          await deleteImage(photo.imageId, actor);
          photosRemoved += 1;
        } catch (error) {
          problems.push(problemOf(photo.name, error));
        }
      }
    }
    report.binned = binned;
    report.photosRemoved = photosRemoved;

    const { created, updated } = imported;
    // A sub product back from the Bin is in `updated`; a main product put in order is in neither.
    const reordered = rows?.reordered.length ?? 0;
    const changed =
      main.added.length +
      main.changed.length +
      created +
      updated +
      reordered +
      listChanges(colours) +
      listChanges(brands) +
      photos.added.length +
      photos.replaced.length +
      landed.recaptioned.length +
      landed.reordered.length +
      binned +
      removed.mainProducts +
      removed.colours +
      removed.brands +
      photosRemoved;
    if (changed > 0) {
      await db().transaction((trx) =>
        activityLog.recordActivity(
          {
            tenantId,
            entityType: 'catalog',
            entityId: tenantId,
            action: 'imported',
            actorType: actor.actorType,
            actorId: actor.actorId,
            details: {
              count: created + updated,
              fileName,
              mode: 'upsert',
              created,
              updated,
              subProductsRestored: rows?.restoredFromBin.length ?? 0,
              subProductsReordered: reordered,
              mainProductsAdded: main.added.length,
              mainProductsRenamed: main.changed.length,
              coloursChanged: listChanges(colours),
              brandsChanged: listChanges(brands),
              photosAdded: photos.added.length,
              photosReplaced: photos.replaced.length,
              photosRecaptioned: landed.recaptioned.length,
              photosReordered: landed.reordered.length,
              binned,
              mainProductsBinned: removed.mainProducts,
              coloursRemoved: removed.colours,
              brandsBinned: removed.brands,
              photosRemoved,
            },
          },
          actor,
          trx,
        ),
      );
      // One event for the catalogue as a whole; each photo and rename has announced itself.
      publishChange({
        entity: 'catalog',
        action: 'updated',
        id: tenantId,
        payload: { created, updated, skipped: imported.skipped, failed: imported.failed },
      });
    }
    log.info(
      `Product zip ${fileName}: ${main.added.length} main products added, ${created} sub products added, ` +
        `${updated} changed, ${photos.added.length} photos added, ${photos.replaced.length} replaced`,
    );
    return report;
  } finally {
    reader.close();
  }
}

/** What the zip would do: nothing is written. */
export function previewProductZip(
  filePath: string,
  fileName: string,
  actor: ActorContext,
): Promise<ProductZipReport> {
  return runZip(filePath, fileName, { dryRun: true }, actor);
}

/** Do it, here and now: the job below, and the shipped catalogue on boot. */
export async function restoreProductZip(
  filePath: string,
  fileName: string,
  options: RunOptions,
  actor: ActorContext,
  progress?: Progress,
): Promise<ProductZipReport> {
  // The shipped photos still being attached stop before the plan reads a
  // gallery; once the run writes, they are retired for good (`runZip`). The
  // boot load's zip is the shipped catalogue itself, so it is the one run that
  // does neither.
  if (!options.keepPhotos) await stopCataloguePhotos();
  return runZip(filePath, fileName, { ...options, dryRun: false }, actor, progress);
}

// --- The one product restore --------------------------------------------------------

let job: ProductRestoreJob | null = null;

/** The latest restore, running or finished, or null since the Master started. */
export function productRestoreJob(): ProductRestoreJob | null {
  return job ? { ...job } : null;
}

/** A full backup restore asks before it starts: it would replace the database under this one. */
export function isProductRestoreRunning(): boolean {
  return Boolean(job && !job.finishedAt);
}

/**
 * Start the real run detached and answer at once; the upload at `filePath` is
 * deleted when it ends. A second start while one runs is refused, not queued,
 * and so is one while a full backup restore runs, whichever came first. The
 * shipped photos' attach is not a reason to refuse: the run stops it, and waits
 * for it, before it reads anything (`restoreProductZip`).
 */
export function startProductRestore(
  filePath: string,
  fileName: string,
  options: ProductRestoreOptions,
  actor: ActorContext,
): ProductRestoreJob {
  requireRestorePermissions(actor, options);
  if (isProductRestoreRunning()) throw new ConflictError('error.conflict.productRestoreBusy');
  if (isJobRunning() && currentJob()?.kind === 'restore')
    throw new ConflictError('error.conflict.backupBusy');

  const current: ProductRestoreJob = {
    id: randomUUID(),
    phase: 'checking',
    done: 0,
    total: 0,
    startedAt: new Date().toISOString(),
  };
  job = current;
  void restoreProductZip(filePath, fileName, options, actor, (progress) =>
    Object.assign(current, progress),
  )
    .then(
      (result) => {
        current.result = result;
        current.phase = 'done';
      },
      (error: unknown) => {
        log.warn(`The product restore of ${fileName} failed: ${toErrorMessage(error)}`);
        current.phase = 'failed';
        current.message =
          error instanceof AppError
            ? { messageKey: error.messageKey, params: error.params as MessageParams }
            : { messageKey: 'productZip.failed' };
      },
    )
    .finally(() => {
      current.finishedAt = new Date().toISOString();
      void rm(filePath, { force: true });
    });
  return { ...current };
}

// --- The catalogue every build ships ------------------------------------------------

/** Where the boot load is recorded (`catalogue-seed.service.ts`). */
export { SHIPPED_CATALOGUE_MARKER };

/**
 * The catalogue this build carries, loaded once, on boot, into a brand-new
 * install: not yet set up, and its catalogue has never held anything, not one
 * main product, the Recycle Bin included. `assets/catalogue/products.zip` when
 * the build carries one (`release --catalogue`), through the restore above;
 * else the printed catalogue (`swisware-plus-2026.md`). Either way as System:
 * nobody exists yet to act as.
 *
 * Recorded under the marker whatever it found, so an install that already has
 * products only gets the marker, and a catalogue a company later empties on
 * purpose is never filled again. An install already set up (one an update
 * reaches, or one a full backup restored) only gets the marker too, even with
 * an empty catalogue: an update never changes an install's data. A load is
 * marked `loading` before its first write, so one the Master stopped in the
 * middle of (the window closed while the photos went in) or one that threw
 * runs again on the next boot while the install is still not set up, without
 * loading anything twice: rows are upserted by code, and a photo already in
 * its slot stays (`keepPhotos`). Once it is set up the company's own data may
 * be there, so it is never carried on. Answers what it loaded, `none` for the
 * marker alone, and null when it had already run.
 */
export async function loadShippedCatalogue(
  sources: { zip?: string; markdown?: string } = {},
  progress?: Progress,
): Promise<'zip' | 'markdown' | 'none' | null> {
  const tenantId = await resolveDefaultTenantId();
  const marker = (await settingsRepo.readSettingRows(tenantId)).find(
    (row) => row.key === SHIPPED_CATALOGUE_MARKER,
  )?.value as { state?: string } | undefined;
  if (marker && marker.state !== 'loading') return null;

  const mark = (value: { state: 'loading' | 'done'; loaded: 'zip' | 'markdown' | 'none' }) =>
    db().transaction((trx) =>
      settingsRepo.upsertSetting(
        tenantId,
        SHIPPED_CATALOGUE_MARKER,
        { ...value, at: new Date().toISOString() },
        false,
        1,
        null,
        trx,
      ),
    );

  // Before the carry-on below: a load that failed on the first boot must not
  // land on what the company has set up or restored since.
  if (await isSetupComplete()) {
    await mark({ state: 'done', loaded: 'none' });
    return 'none';
  }
  // A load already under way carries on over what it wrote; otherwise only into a catalogue never used.
  if (!marker && (await db()('product_categories').where({ tenant_id: tenantId }).first('id'))) {
    await mark({ state: 'done', loaded: 'none' });
    return 'none';
  }

  const actor: ActorContext = {
    ...systemActor(tenantId),
    permissions: {
      roleId: null,
      roleName: 'System',
      tier: 'admin',
      permissions: [
        'products.view',
        'products.bulk',
        'products.create',
        'products.edit',
        'catalog.lists.manage',
      ],
    },
  };
  const zip = sources.zip ?? config.catalogueZip;
  const loaded = (await access(zip).then(
    () => true,
    () => false,
  ))
    ? 'zip'
    : 'markdown';
  await mark({ state: 'loading', loaded });
  if (loaded === 'zip') {
    const report = await restoreProductZip(
      zip,
      path.basename(zip),
      { keepPhotos: true },
      actor,
      progress,
    );
    if (report.problems.length > 0) {
      log.warn(
        `The shipped catalogue loaded, but ${report.problems.length} things could not be done: ` +
          report.problems
            .slice(0, 5)
            .map((problem) => `${problem.subject} (${problem.messageKey})`)
            .join(', '),
      );
    }
  } else {
    await loadCatalogue(await readCatalogueFile(sources.markdown), actor, { replace: false });
  }
  await mark({ state: 'done', loaded });
  return loaded;
}
