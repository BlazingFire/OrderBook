/**
 * The product backup zip: the whole catalogue as one file a person can open,
 * edit and put back (`docs/PRODUCT_IMPORT_FORMAT.md`, "The product backup zip").
 *
 *     products.csv         the sub product export, the import's own columns
 *     main-products.csv    Brand, Main product code, Main product, Order
 *     colours.csv          Colour, Hex
 *     images/OPT-0001.webp photo 1 of OPT-0001; OPT-0001_2.webp is photo 2
 *     README.txt
 *
 * **Nothing here is a second importer.** `products.csv` goes back through the
 * upsert import (`importProducts`, with `restore`), the photos through the bulk
 * photo import's planner and run (`shared/src/domain/photo-import.ts`) and the
 * ordinary one-photo upload, so a row or a photo lands exactly as one added on
 * the screens would. What the zip adds is the parts the CSV cannot carry: main
 * products created with their code, brand and order (a code never creates one
 * in the import, so an empty catalogue could not be restored), main products
 * renamed, the colour list with its hex, and photos compared by content.
 *
 * **Change detection is exact.** A photo is written as its stored `master.webp`,
 * byte for byte, so its sha256 is `product_images.checksum`. A photo put in
 * the zip (any jpg, png or webp) is re-encoded on upload, so the row also keeps
 * the hash of the file it came from, `source_checksum`. Either hash is an
 * unchanged photo, any other a replaced one. A row is unchanged by the
 * import's own test (`changedCells`), which also names each changed cell.
 *
 * **Missing is reported, not removed.** A sub product whose codes the file no
 * longer names, or a photo of the file's sub products with no file, is listed.
 * Only the two opt-ins act on them: the first moves sub products to the Recycle
 * Bin through the ordinary delete (so it can be undone), the second deletes the
 * photos. A zip that carries only `products.csv` therefore never erases a photo.
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
import { access, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import {
  CATEGORY_CODE_PATTERN,
  galleryOrder,
  MAX_IMAGE_SOURCE_BYTES,
  MAX_PRODUCT_IMPORT_BYTES,
  newestImageId,
  planPhotoImport,
  runPhotoImport,
  type MessageKey,
  type MessageParams,
  type PhotoPlanRow,
  type Product,
  type ProductCellChange,
  type ProductImage,
  type ProductRestoreJob,
  type ProductRestoreOptions,
  type ProductZipProblem,
  type ProductZipReport,
} from '@orderbook/shared';

import { config } from '../config/index.js';
import { requirePermission, systemActor, type ActorContext } from '../domain/actor.js';
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
import { currentJob, isJobRunning } from './backup-job.js';
import * as catalog from './catalog.service.js';
import { loadCatalogue, readCatalogueFile, upsertOptions } from './catalogue-seed.service.js';
import { publishChange } from './change-bus.js';
import { deleteImage, reorderImages, updateImageCaption, uploadImage } from './image.service.js';
import { buildProductExport, importProducts, registerBrands } from './product-import.service.js';
import { getIdentity } from './setup.service.js';

const log = createLogger('product-zip');

const PRODUCTS_CSV = 'products.csv';
const MAIN_PRODUCTS_CSV = 'main-products.csv';
const COLOURS_CSV = 'colours.csv';
const MAIN_HEADERS = ['Brand', 'Main product code', 'Main product', 'Order'];
const COLOUR_HEADERS = ['Colour', 'Hex'];
const HEX = /^#[0-9a-f]{6}$/i;

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
 * `_N` past the first slot. Null for a sub product with no live code, and for
 * a photo N whose `CODE_N` is another sub product's code: the planner reads
 * that name as the other one's photo 1, so this photo has no name to go under.
 */
function photoBaseName(
  product: Product,
  image: ProductImage,
  slot: number,
  codes: ReadonlySet<string>,
): string | null {
  const live = product.variants.filter((variant) => variant.isActive);
  const caption = image.caption?.trim().toLowerCase();
  const variant =
    (product.hasVariants && caption
      ? live.find((candidate) => (candidate.label ?? '').trim().toLowerCase() === caption)
      : undefined) ?? live[0];
  if (!variant) return null;
  if (slot === 1) return variant.code;
  const name = `${variant.code}_${slot}`;
  return codes.has(name.toLowerCase()) ? null : name;
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

/** `unnamed`: the photos left out because no name would bring them back, as "sub product, photo N". */
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
    '  main-products.csv  The main products: their code, brand and order.',
    '  colours.csv        The colour list, with the hex value of each colour.',
    '  images             Every product photo, named by the sub product Code:',
    '                     OPT-0001.webp is the first (main) photo of OPT-0001,',
    '                     OPT-0001_2.webp its second photo, OPT-0001_3.webp its third.',
    '                     A Code holding a character a file name cannot (/ \\ : * ? " < > | %)',
    '                     has it written as % and two digits: SW/101 is SW%2F101.webp.',
    '',
    'HOW TO EDIT',
    '',
    '  1. Unzip it, change what you need, and zip the folder again with any zip tool.',
    '  2. Change a cell to change that value. Leave the Code column as it is: the Code is how',
    '     each row finds its sub product.',
    '  3. To add a sub product, add a row with a new Code that no other row uses.',
    '  4. To rename a main product or change its brand, change it in main-products.csv: the',
    '     Main product and Brand cells of products.csv are not read for a main product listed',
    '     there. Order only places a main product the restore adds; to reorder the ones you',
    '     have, use the Main products screen.',
    '  5. To replace a photo, put the new picture in the images folder under the same name and',
    '     delete the old file, even when the ending differs: OPT-0001.jpg replaces OPT-0001.webp.',
    '     jpg, png and webp pictures are accepted.',
    '  6. To add a second photo, name it OPT-0001_2.jpg (a third: OPT-0001_3.jpg, and so on).',
    '  7. On the Master, open Products > Sub products > Restore from .zip and choose the zip.',
    '     It lists every change first; nothing is saved until you press Apply.',
    '',
    'WHAT REMOVING DOES',
    '',
    '  A row deleted from products.csv, or a photo deleted from the images folder, is only',
    '  listed when you restore. Nothing is removed unless you tick "Move sub products missing',
    '  from the file to the Recycle Bin" or "Remove photos missing from the zip". Sub products',
    '  in the Recycle Bin can be brought back from there; a removed photo cannot.',
    '',
    'EXCEL',
    '',
    '  Excel changes some values when it opens a CSV file: a size like 10-12 can turn into a',
    '  date, and a number can lose its leading zeros. Check those cells before saving, and save',
    '  as "CSV UTF-8 (Comma delimited)". Notepad and LibreOffice leave the values as they are.',
    '',
    'PHOTOS',
    '',
    '  A photo is recognised as unchanged by its exact bytes: one you did not touch, and one you',
    '  put in that a restore has already brought in. Restoring the same zip twice adds nothing.',
    '',
    ...(unnamed.length > 0
      ? [
          'NOT IN THIS ZIP',
          '',
          '  These photos are not in the images folder: their sub product has no Code in use, or',
          '  the name the photo would take is the Code of another sub product. Restoring this zip',
          '  leaves them as they are.',
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

    const categories = await productRepo.listCategories(tenantId);
    const mainRows = categories.map((category, index) => [
      category.brand ?? '',
      category.code ?? '',
      category.name,
      index + 1,
    ]);
    await writer.appendEntry(MAIN_PRODUCTS_CSV, ['﻿' + toCsv(MAIN_HEADERS, mainRows)]);

    // The values in use: one switched off is not offered, and restoring it would switch it back on.
    const colours = await customFieldRepo.listOptionsForKey(tenantId, 'stock.colour');
    const colourRows = colours
      .filter((option) => option.isActive)
      .map((option) => [option.value, option.hex ?? '']);
    await writer.appendEntry(COLOURS_CSV, ['﻿' + toCsv(COLOUR_HEADERS, colourRows)]);

    const { items } = await productRepo.listProducts(tenantId, { limit: 100_000, offset: 0 });
    const codes = codesOf(items);
    const unnamed: string[] = [];
    for (const product of items) {
      for (const [index, image] of galleryImages(product).entries()) {
        const name = photoBaseName(product, image, index + 1, codes);
        if (name === null) {
          unnamed.push(`${product.name}, photo ${index + 1}`);
          continue;
        }
        const source = masterFile(tenantId, image.id);
        // A row whose files are gone (healed on the next boot, if it was shipped) has nothing to write.
        if (
          !(await access(source).then(
            () => true,
            () => false,
          ))
        ) {
          log.warn(`Photo ${image.id} of ${product.name} has no file to back up`);
          continue;
        }
        // Already compressed: stored, so the bytes in the zip are the bytes on disk.
        await writer.appendEntry(`images/${fileSafe(name)}.webp`, createReadStream(source), {
          store: true,
        });
        photos += 1;
      }
    }
    if (unnamed.length > 0)
      log.warn(`${unnamed.length} photos have no name to go under, so the backup leaves them out`);

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

/** One fixed file, found by its name wherever it sits, case aside. Two of them is a question only the person can answer. */
function findEntry(reader: ZipReader, file: string): string | null {
  const hits = reader.entries.filter(
    (entry) => !entry.name.endsWith('/') && baseName(entry.name).toLowerCase() === file,
  );
  if (hits.length > 1) throw new ValidationError('validation.productZip.manyFiles', { file });
  return hits[0]?.name ?? null;
}

async function entryBytes(
  reader: ZipReader,
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
  reader: ZipReader,
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

/** A main product as a file asks for it. `brand` undefined leaves the brand as it is. */
interface MainRow {
  code: string | null;
  name: string;
  brand: string | null | undefined;
  order: number | null;
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
  colours: Array<{ value: string; hex: string | null }>;
  photos: ZipPhoto[];
  /** A second file under the very same name, in another folder: never planned. */
  extraPhotos: string[];
}

async function readZip(reader: ZipReader, problems: ProductZipProblem[]): Promise<ZipContents> {
  const productsEntry = findEntry(reader, PRODUCTS_CSV);
  if (!productsEntry) throw new ValidationError('validation.productZip.noProductsCsv');
  const products = await sheetOf(reader, productsEntry);

  // The header is checked here, before anything is written, with the import's own words.
  const headerAt = products.rows.findIndex((row) => !isBlankRow(row));
  if (headerAt === -1) throw new ValidationError('validation.import.emptyFile');
  const match = matchHeaders((products.rows[headerAt] ?? []).map((cell) => cell.trim()));
  if (match.missing.length > 0) {
    throw new ValidationError('validation.import.missingColumn', {
      column: labelOf(match.missing[0] as ImportField),
    });
  }
  const at = (field: ImportField): number =>
    match.byIndex.findIndex((column) => column?.field === field);
  const cell = (row: readonly string[], index: number): string =>
    index >= 0 ? (row[index] ?? '').trim() : '';

  const fileCodes = new Set<string>();
  // A main product products.csv names by a code main-products.csv does not list: its first row says what it is.
  const named: MainRow[] = [];
  // Every row's own main product cells, to say where main-products.csv, the one read, disagrees.
  const cells: Array<{ code: string; name: string; brand: string }> = [];
  for (const row of products.rows.slice(headerAt + 1)) {
    if (isBlankRow(row)) continue;
    const code = cell(row, at('code'));
    if (code) fileCodes.add(code.toLowerCase());
    const mainCode = cell(row, at('categoryCode'));
    if (!mainCode) continue;
    const name = cell(row, at('categoryName'));
    const brand = cell(row, at('categoryBrand'));
    cells.push({ code: mainCode.toLowerCase(), name, brand });
    if (!named.some((main) => main.code?.toLowerCase() === mainCode.toLowerCase())) {
      named.push({ code: mainCode, name, brand: brand || undefined, order: null });
    }
  }
  // A header and nothing else: refused here, before a main product is written, not by the import after.
  if (products.rows.slice(headerAt + 1).every(isBlankRow))
    throw new ValidationError('validation.import.emptyFile');

  const mainProducts: MainRow[] = [];
  const mainEntry = findEntry(reader, MAIN_PRODUCTS_CSV);
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
      const order = Number.parseInt(cell(row, orderAt), 10);
      mainProducts.push({
        code: cell(row, mainAt('categoryCode')) || null,
        name: cell(row, mainAt('categoryName')),
        // No Brand column leaves every brand as it is; an empty cell clears that one.
        brand: brandAt === -1 ? undefined : cell(row, brandAt) || null,
        order: Number.isInteger(order) && order >= 0 ? order : null,
      });
    }

    const differs = (code: string, field: ImportField, value: string, listed: string): void => {
      problems.push({
        subject: code,
        messageKey: 'validation.productZip.mainDiffers',
        params: { column: labelOf(field), value, main: listed },
      });
    };
    for (const main of mainProducts) {
      if (!main.code) continue;
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

  const colours: ZipContents['colours'] = [];
  const colourEntry = findEntry(reader, COLOURS_CSV);
  if (colourEntry) {
    const { rows } = await sheetOf(reader, colourEntry);
    const header = (rows[0] ?? []).map((text) => normalizeHeader(text ?? ''));
    const valueAt = header.findIndex((text) => text === 'colour' || text === 'color');
    const hexAt = header.indexOf('hex');
    for (const row of rows.slice(1)) {
      const value = cell(row, valueAt);
      // A value listed twice is one colour: the first row says its hex.
      if (!value || colours.some((colour) => colour.value === value)) continue;
      const hex = cell(row, hexAt);
      if (hex && !HEX.test(hex))
        problems.push({
          subject: value,
          messageKey: 'validation.productZip.hexInvalid',
          params: { hex },
        });
      colours.push({ value, hex: HEX.test(hex) ? hex : null });
    }
  }

  // Photos are the files in a folder named `images`, at any depth; anything else in the zip is not looked at.
  const photos: ZipPhoto[] = [];
  const extraPhotos: string[] = [];
  for (const { name: entry } of reader.entries) {
    if (
      entry.endsWith('/') ||
      !entry
        .split('/')
        .slice(0, -1)
        .some((folder) => folder.toLowerCase() === 'images')
    )
      continue;
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

  return { productsCsv: products.bytes, fileCodes, mainProducts, colours, photos, extraPhotos };
}

// --- Main products and colours ---------------------------------------------------

interface MainPlan {
  added: productRepo.CategorySeed[];
  renamed: Array<{
    id: string;
    code: string;
    name: string;
    brand: string | null | undefined;
    fields: ProductCellChange[];
  }>;
}

/**
 * Which main products the zip adds and renames. Created only where nothing
 * live matches by code or by (brand, name) — `ensureCategories`' own rule, so
 * the preview and the run agree. A brand is spelled as the Brands list does.
 */
async function planMainProducts(
  rows: readonly MainRow[],
  tenantId: string,
  problems: ProductZipProblem[],
): Promise<MainPlan> {
  const live = await productRepo.listCategories(tenantId);
  const brandByLower = new Map<string, string>();
  for (const category of live)
    if (category.brand) brandByLower.set(category.brand.toLowerCase(), category.brand);
  for (const option of await customFieldRepo.listOptionsForKey(tenantId, 'product.brand')) {
    brandByLower.set(option.value.toLowerCase(), option.value);
  }
  const lower = (value: string | null | undefined): string => (value ?? '').toLowerCase();

  const plan: MainPlan = { added: [], renamed: [] };
  rows.forEach((row, index) => {
    if (!row.name) return;
    if (row.code && !CATEGORY_CODE_PATTERN.test(row.code)) {
      problems.push({
        subject: row.code,
        messageKey: 'validation.productZip.codeInvalid',
        params: { code: row.code },
      });
      return;
    }
    const brand = row.brand ? (brandByLower.get(row.brand.toLowerCase()) ?? row.brand) : row.brand;

    const byCode = row.code
      ? live.find((category) => lower(category.code) === lower(row.code))
      : undefined;
    if (byCode) {
      const fields: ProductCellChange[] = [];
      if (byCode.name !== row.name)
        fields.push({ column: labelOf('categoryName'), from: byCode.name, to: row.name });
      if (brand !== undefined && (byCode.brand ?? null) !== brand) {
        fields.push({
          column: labelOf('categoryBrand'),
          from: byCode.brand ?? '',
          to: brand ?? '',
        });
      }
      if (fields.length > 0)
        plan.renamed.push({
          id: byCode.id,
          code: byCode.code as string,
          name: row.name,
          brand,
          fields,
        });
      return;
    }
    const byName = live.some(
      (category) =>
        lower(category.name) === lower(row.name) &&
        (!brand || lower(category.brand) === lower(brand)),
    );
    if (!byName)
      plan.added.push({
        code: row.code,
        name: row.name,
        brand: brand ?? null,
        sortOrder: row.order ?? index + 1,
      });
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

/** Create, then rename one by one through the ordinary edit (its checks, its event); answers the renames that went through. */
async function applyMainProducts(
  plan: MainPlan,
  actor: ActorContext,
  problems: ProductZipProblem[],
): Promise<MainPlan['renamed']> {
  const { tenantId } = actor;
  const listed = await customFieldRepo.listOptionsForKey(tenantId, 'product.brand');
  await db().transaction(async (trx) => {
    await registerBrands(
      tenantId,
      [...plan.added, ...plan.renamed].map((main) => main.brand ?? ''),
      listed,
      trx,
    );
    await productRepo.ensureCategories(tenantId, plan.added, trx);
  });
  customFieldRepo.invalidateFieldCache(tenantId);

  const done: MainPlan['renamed'] = [];
  for (const rename of plan.renamed) {
    try {
      await catalog.updateCategory(
        rename.id,
        { name: rename.name, ...(rename.brand !== undefined ? { brand: rename.brand } : {}) },
        actor,
      );
      done.push(rename);
    } catch (error) {
      problems.push(problemOf(rename.code, error));
    }
  }
  return done;
}

/** `upsertOptions`' own reading: a value missing, binned or switched off is added; a different hex is a change. */
async function planColours(
  colours: ZipContents['colours'],
  tenantId: string,
): Promise<ProductZipReport['colours']> {
  const existing = await customFieldRepo.listOptionsForKey(tenantId, 'stock.colour', {
    includeDeleted: true,
  });
  const report: ProductZipReport['colours'] = { added: [], changed: [] };
  for (const { value, hex } of colours) {
    const matches = existing.filter((option) => option.value === value);
    const hit = matches.find((option) => !option.deletedAt) ?? matches[0];
    if (!hit || hit.deletedAt || !hit.isActive) report.added.push(value);
    else if (hex !== null && hit.hex !== hex)
      report.changed.push({ column: value, from: hit.hex ?? '', to: hex });
  }
  return report;
}

// --- Photos ------------------------------------------------------------------------

interface PhotoPlan {
  report: ProductZipReport['photos'];
  /** What the run uploads: new photos and replaced ones, never an unchanged one. */
  toRun: PhotoPlanRow<ZipPhoto>[];
  /** The zip's slot of each photo it keeps as it is, by image id. */
  keptSlots: Map<string, number>;
  /** Photos of the file's sub products that no file names. */
  notInZip: Array<{ imageId: string; name: string }>;
}

/**
 * `sourceOf`: each photo's `source_checksum`, by image id. A photo is
 * unchanged when its file hashes to its master's checksum or to that.
 *
 * `keepPhotos`: a photo already in a slot stays, whatever its bytes. The boot
 * load asks for it: it only ever fills an empty catalogue, so a photo there is
 * one an interrupted load already put in (its source hash matches anyway), or
 * one the shipped catalogue photos or a person put in while it was stopped.
 */
function planPhotos(
  zip: ZipContents,
  products: readonly Product[],
  sourceOf: ReadonlyMap<string, string>,
  keepPhotos = false,
): PhotoPlan {
  const plan = planPhotoImport(zip.photos, products);
  const checksumOf = new Map(
    products.flatMap((product) => product.images.map((image) => [image.id, image.checksum])),
  );
  const unchanged = (imageId: string, sha256: string) =>
    checksumOf.get(imageId) === sha256 || sourceOf.get(imageId) === sha256;
  const report: ProductZipReport['photos'] = {
    added: [],
    replaced: [],
    unchanged: 0,
    unmatched: [],
    duplicate: [...zip.extraPhotos],
    notImage: [],
    notInZip: [],
  };
  const toRun: PhotoPlanRow<ZipPhoto>[] = [];
  const keptSlots = new Map<string, number>();

  for (const row of plan) {
    if (row.status === 'new') {
      report.added.push(row.fileName);
      toRun.push(row);
    } else if (row.status === 'hasPhoto') {
      if (keepPhotos || unchanged(row.slotImageId as string, row.file.sha256)) {
        report.unchanged += 1;
        keptSlots.set(row.slotImageId as string, row.slot ?? 1);
      } else {
        report.replaced.push(row.fileName);
        toRun.push(row);
      }
    } else if (row.status === 'unmatched') report.unmatched.push(row.fileName);
    else if (row.status === 'duplicate') report.duplicate.push(row.fileName);
    else report.notImage.push(row.fileName);
  }

  const named = new Set(plan.flatMap((row) => (row.slotImageId ? [row.slotImageId] : [])));
  const codes = codesOf(products);
  const notInZip: PhotoPlan['notInZip'] = [];
  for (const product of products) {
    if (!product.variants.some((variant) => zip.fileCodes.has(variant.code.toLowerCase())))
      continue;
    galleryImages(product).forEach((image, index) => {
      // A photo with no name to go under is in no zip, so never missing from one (the README lists it).
      const name = photoBaseName(product, image, index + 1, codes);
      if (name !== null && !named.has(image.id)) notInZip.push({ imageId: image.id, name });
    });
  }
  report.notInZip = notInZip.map((photo) => photo.name);
  return { report, toRun, keptSlots, notInZip };
}

/**
 * Upload the plan through the ordinary pipeline, "replace" as the photo import
 * runs it (new photo in first, a new photo 1 made primary, then the old one
 * out), then put each sub product's gallery in the zip's order: an upload
 * lands last, so a replaced photo 2 would otherwise come back as photo 3.
 */
async function runPhotos(
  reader: ZipReader,
  plan: PhotoPlan,
  actor: ActorContext,
  problems: ProductZipProblem[],
  progress: (done: number, total: number) => void,
): Promise<{ added: string[]; replaced: string[] }> {
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

  const landed = { added: [] as string[], replaced: [] as string[] };
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

  for (const productId of touched) {
    const product = await productRepo.findProductById(actor.tenantId, productId);
    if (!product) continue;
    const gallery = galleryOrder(product);
    // Photos the zip does not name keep their order, after the ones it does.
    const place = (id: string): number => slots.get(id) ?? 1_000_000 + gallery.indexOf(id);
    const wanted = [...gallery].sort((a, b) => place(a) - place(b));
    if (wanted.some((id, index) => id !== gallery[index])) {
      await reorderImages({ productId, ids: wanted }, actor).catch((error: unknown) =>
        problems.push(problemOf(product.name, error)),
      );
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
  if (options.binMissingProducts) requirePermission(actor, 'products.delete');
}

/** `keepPhotos` is the boot load's alone (`planPhotos`); no request can ask for it. */
type RunOptions = ProductRestoreOptions & { keepPhotos?: boolean };

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
  const problems: ProductZipProblem[] = [];

  let reader: ZipReader;
  try {
    reader = await openZipReader(filePath, MAX_ARCHIVE_ENTRIES, { windowsNames: true });
  } catch (error) {
    throw zipRefusal(error);
  }

  try {
    progress({ phase: 'checking' });
    const zip = await readZip(reader, problems).catch((error: unknown) => {
      throw zipRefusal(error);
    });

    const main = await planMainProducts(zip.mainProducts, tenantId, problems);
    const colours = await planColours(zip.colours, tenantId);
    // Changing the colour list is the lists' own permission, asked before anything is written.
    if (colours.added.length + colours.changed.length > 0)
      requirePermission(actor, 'catalog.lists.manage');

    let renamed = main.renamed;
    if (!dryRun) {
      progress({ phase: 'products' });
      // The colours first: one transaction, so a refusal there leaves nothing half written.
      if (colours.added.length + colours.changed.length > 0) {
        await db().transaction((trx) => upsertOptions(tenantId, 'stock.colour', zip.colours, trx));
        customFieldRepo.invalidateFieldCache(tenantId);
      }
      renamed = await applyMainProducts(main, actor, problems);
    }

    const { rows, ...imported } = await importProducts(
      { buffer: zip.productsCsv, fileName: PRODUCTS_CSV },
      { dryRun, mode: 'upsert', restore: dryRun ? { pendingCategories: main.added } : {} },
      actor,
    );
    const added = rows?.added ?? [];

    const live = (await productRepo.listProducts(tenantId, { limit: 100_000, offset: 0 })).items;
    const missing = live.filter((product) => {
      const codes = product.variants
        .filter((variant) => variant.isActive)
        .map((variant) => variant.code.toLowerCase());
      return codes.length > 0 && !codes.some((code) => zip.fileCodes.has(code));
    });

    // A dry run plans the photos of the rows it would add against stand-ins:
    // the planner reads only their id, codes and (empty) gallery.
    const pending = dryRun
      ? added.map(
          (row) =>
            ({
              id: `pending:${row.code}`,
              name: row.name,
              alias: null,
              hasVariants: false,
              variants: [{ code: row.code, label: null, isActive: true }],
              images: [],
            }) as unknown as Product,
        )
      : [];
    const photoPlan = planPhotos(
      zip,
      [...live, ...pending],
      await imageRepo.sourceChecksumsForTenant(tenantId),
      options.keepPhotos,
    );
    const photos = photoPlan.report;

    const report: ProductZipReport = {
      dryRun,
      fileName,
      mainProducts: {
        added: main.added.map((seed) => ({
          code: seed.code ?? '',
          name: seed.name,
          brand: seed.brand ?? null,
        })),
        renamed: renamed.map((rename) => ({ code: rename.code, fields: rename.fields })),
      },
      products: imported,
      rows: {
        added,
        changed: rows?.changed ?? [],
        notInFile: missing.map((product) => ({
          code: product.variants.find((variant) => variant.isActive)?.code ?? '',
          name: product.name,
        })),
      },
      colours,
      photos,
      problems,
    };
    if (dryRun) return report;

    progress({ phase: 'photos', done: 0, total: photoPlan.toRun.length });
    const landed = await runPhotos(reader, photoPlan, actor, problems, (done, total) =>
      progress({ done, total }),
    );
    photos.added = landed.added;
    photos.replaced = landed.replaced;

    progress({ phase: 'removing', done: 0, total: 0 });
    let binned = 0;
    if (options.binMissingProducts) {
      for (const product of missing) {
        try {
          await catalog.deleteProduct(product.id, actor);
          binned += 1;
        } catch (error) {
          problems.push(problemOf(product.variants[0]?.code ?? product.name, error));
        }
      }
    }
    let photosRemoved = 0;
    if (options.removeMissingPhotos) {
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
    const changed =
      main.added.length +
      renamed.length +
      created +
      updated +
      colours.added.length +
      colours.changed.length +
      photos.added.length +
      photos.replaced.length +
      binned +
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
              mainProductsAdded: main.added.length,
              mainProductsRenamed: renamed.length,
              coloursChanged: colours.added.length + colours.changed.length,
              photosAdded: photos.added.length,
              photosReplaced: photos.replaced.length,
              binned,
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
export function restoreProductZip(
  filePath: string,
  fileName: string,
  options: RunOptions,
  actor: ActorContext,
  progress?: Progress,
): Promise<ProductZipReport> {
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
 * and so is one while a full backup restore runs, whichever came first.
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

/**
 * Where the boot load is recorded: a settings row no `SETTINGS` definition
 * names, so no screen shows it (as `internal.cataloguePhotosAttached`):
 * `state: 'loading'` before the load writes anything, `'done'` once it ends.
 */
export const SHIPPED_CATALOGUE_MARKER = 'internal.shippedCatalogueLoaded';

/**
 * The catalogue this build carries, loaded once, on boot, into an install
 * whose catalogue has never held anything: not one main product, the Recycle
 * Bin included, before setup or after it. `assets/catalogue/products.zip` when
 * the build carries one (`release --catalogue`), through the restore above;
 * else the printed catalogue (`swisware-plus-2026.md`). Either way as System:
 * nobody may exist yet to act as.
 *
 * Recorded under the marker whatever it found, so an install that already has
 * products only gets the marker, and a catalogue a company later empties on
 * purpose is never filled again. A load is marked `loading` before its first
 * write, so one the Master stopped in the middle of (the window closed while
 * the photos went in) or one that threw runs again on the next boot, without
 * loading anything twice: rows are upserted by code, and a photo already in
 * its slot stays (`keepPhotos`). Answers what it loaded, `none` for the
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
