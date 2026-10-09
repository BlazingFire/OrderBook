/**
 * The catalogue's photos, shipped with the Master under
 * `assets/catalogue/photos/` as `<sub product code>.jpg`, attached on boot to
 * the sub products that still have no photo.
 *
 * Through the bulk photo import's own plan and run
 * (`shared/src/domain/photo-import.ts`) in "skip" mode, and the ordinary
 * upload, so a photo lands exactly as one added by hand would — and **never**
 * over one the company added: a sub product with any photo is left alone,
 * checked again as each photo is written (`onlyIfEmpty`).
 *
 * **Once per install, and only on the printed catalogue it loaded**
 * (`SHIPPED_CATALOGUE_MARKER` says `loaded: 'markdown'`): a brand-new install,
 * once its catalogue is in. An update never attaches: an
 * install with any record of a run is done, whatever the next build ships, and
 * an install that never loaded the printed catalogue (one from 1.4.4 or
 * earlier, or a build that shipped `products.zip`, whose photos it carries)
 * never starts. The run is recorded once it ends, whatever it attached,
 * skipped or failed (a failed photo is logged, not retried), so a photo the
 * company removes stays removed.
 *
 * **A restore comes first.** A product restore stops a run under way after the
 * photo it is on, waits for it, and retires the attach for good
 * (`retireCataloguePhotos`); a full backup restore stops it the same way
 * (`stopCataloguePhotos`). A stopped run records nothing, so a restore that
 * never got as far as replacing anything leaves the next boot to carry on.
 *
 * Every boot, before that marker is looked at, the photos' files are checked
 * (`healMissingImageFiles`): a row whose variant files are gone (a database
 * restored without `uploads/`, a copied or cleaned data folder) gets them
 * written again from its shipped photo, under the same id. The marker records
 * what was attached, never that the files are still there.
 *
 * Offline: the files are on disk beside the program, nothing is fetched.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { planPhotoImport, runPhotoImport, type PhotoResult } from '@orderbook/shared';

import { config } from '../config/index.js';
import { systemActor, type ActorContext } from '../domain/actor.js';
import { db } from '../db/knex.js';
import { createLogger } from '../lib/logger.js';
import * as imageRepo from '../repositories/product-image.repository.js';
import * as productRepo from '../repositories/product.repository.js';
import * as settingsRepo from '../repositories/settings.repository.js';
import { resolveDefaultTenantId } from '../repositories/tenant.repository.js';
import { SHIPPED_CATALOGUE_MARKER } from './catalogue-seed.service.js';
import {
  GalleryTakenError,
  imageVariantsMissing,
  rederiveImageVariants,
  SourceMismatchError,
  uploadImage,
} from './image.service.js';

const log = createLogger('catalogue-photos');

/**
 * Where the run is recorded: a settings row no `SETTINGS` definition names, so
 * the Settings screen and the snapshot never show it (`settings.service.ts`
 * reads only the declared keys).
 */
export const CATALOGUE_PHOTOS_MARKER = 'internal.cataloguePhotosAttached';

export interface CataloguePhotosResult {
  files: number;
  attached: number;
  /** Sub products that already had a photo, and files that matched nothing. */
  skipped: number;
  failed: number;
}

export interface ImageFilesHealResult {
  /** Rows with at least one variant file missing. */
  missing: number;
  /** Written again from the shipped photo. */
  healed: number;
  /** No shipped photo is that image (one the company uploaded, or a set that changed): left as it is. */
  unsourced: number;
  failed: number;
}

/**
 * Write again the variant files of every photo whose files are gone, from the shipped photo in its
 * slot, under the same image id. Rows are never deleted: one with no source stays, and the panels
 * show the empty photo tile for it. A second run finds the files and does nothing.
 */
export async function healMissingImageFiles(
  tenantId: string,
  dir: string,
  names: string[],
): Promise<ImageFilesHealResult> {
  const missing: Array<{ id: string; productId: string }> = [];
  for (const ref of await imageRepo.imageRefsForTenant(tenantId)) {
    if (await imageVariantsMissing(tenantId, ref.id)) missing.push(ref);
  }
  const result: ImageFilesHealResult = { missing: missing.length, healed: 0, unsourced: 0, failed: 0 };
  if (missing.length === 0) return result;

  // The import's own matching names the photo in each file's slot.
  const products = (await productRepo.listProducts(tenantId, { limit: 100_000, offset: 0 })).items;
  const sourceOf = new Map<string, string>();
  for (const row of planPhotoImport(names.map((name) => ({ name })), products)) {
    if (row.slotImageId) sourceOf.set(row.slotImageId, row.fileName);
  }

  for (const ref of missing) {
    const fileName = sourceOf.get(ref.id);
    if (!fileName) {
      result.unsourced += 1;
      continue;
    }
    try {
      await rederiveImageVariants(tenantId, ref.id, await readFile(path.join(dir, fileName)));
      result.healed += 1;
    } catch (error) {
      if (error instanceof SourceMismatchError) {
        result.unsourced += 1;
      } else {
        result.failed += 1;
        log.warn(`Photo ${ref.id} from ${fileName}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  log.warn(
    `Photo files missing for ${result.missing} photo(s): ${result.healed} written again from the shipped photos, ` +
      `${result.unsourced} with no shipped source (shown as no photo), ${result.failed} failed`,
  );
  return result;
}

/** The run under way, if any, and whether a restore has asked it to stop. */
let running: Promise<unknown> | null = null;
let stopRequested = false;

/**
 * Stop a run under way after the photo it is on, and wait until it has: a
 * restore must not write the catalogue while shipped photos land beside it.
 */
export async function stopCataloguePhotos(): Promise<void> {
  if (!running) return;
  stopRequested = true;
  try {
    await running.catch(() => undefined);
  } finally {
    stopRequested = false;
  }
}

/** A restore of the company's own catalogue: no shipped photo is attached on this install again. */
export async function retireCataloguePhotos(): Promise<void> {
  await stopCataloguePhotos();
  const tenantId = await resolveDefaultTenantId();
  await db().transaction((trx) =>
    settingsRepo.upsertSetting(
      tenantId,
      CATALOGUE_PHOTOS_MARKER,
      { retired: true, at: new Date().toISOString() },
      false,
      1,
      null,
      trx,
    ),
  );
}

/** Null when there is nothing to do: no printed catalogue loaded, or already done. */
export async function attachCataloguePhotos(
  dir: string = config.cataloguePhotosDir,
): Promise<CataloguePhotosResult | null> {
  const run = attach(dir);
  running = run;
  try {
    return await run;
  } finally {
    if (running === run) running = null;
  }
}

async function attach(dir: string): Promise<CataloguePhotosResult | null> {
  const names = (await readdir(dir).catch(() => [] as string[])).filter((name) => /\.(jpe?g|png|webp)$/i.test(name));
  const tenantId = await resolveDefaultTenantId();
  await healMissingImageFiles(tenantId, dir, names);

  // No early return for an empty folder: a run with nothing to attach is still the one run, so a
  // later build that does ship photos never attaches them on an update.
  const rows = await settingsRepo.readSettingRows(tenantId);
  const valueOf = (key: string) => rows.find((row) => row.key === key)?.value;
  const shipped = valueOf(SHIPPED_CATALOGUE_MARKER) as { state?: string; loaded?: string } | undefined;
  if (valueOf(CATALOGUE_PHOTOS_MARKER) !== undefined || shipped?.state !== 'done' || shipped.loaded !== 'markdown')
    return null;

  // The program does this, not a person: the activity log says System. It
  // holds the one permission the upload asks for and nothing else.
  const actor: ActorContext = {
    ...systemActor(tenantId),
    permissions: { roleId: null, roleName: 'System', tier: 'admin', permissions: ['products.edit'] },
  };

  const products = (await productRepo.listProducts(tenantId, { limit: 100_000, offset: 0 })).items;
  // Stricter than the screen's "skip": not just a taken slot, any photo at
  // all keeps a sub product out, so a shipped `CODE_2.jpg` never lands beside
  // a photo the company chose.
  const plan = planPhotoImport(
    names.map((name) => ({ name })),
    products,
  ).map((row) => (row.status === 'new' && (row.existingImageIds?.length ?? 0) > 0 ? { ...row, status: 'hasPhoto' as const } : row));
  // A photo the company added after the plan was read keeps its sub product; the run's own
  // later photos of a sub product (a `CODE_2.jpg`, a second colour's code) still land.
  let taken = 0;
  const mine = new Set<string>();
  const outcomes = await runPhotoImport(plan, 'skip', {
    upload: async (productId, file) => {
      try {
        await uploadImage(
          {
            productId,
            fileBuffer: await readFile(path.join(dir, file.name)),
            crop: { cropX: 0, cropY: 0, cropWidth: 0, cropHeight: 0, rotationDeg: 0 },
            wholeFrame: true,
            onlyIfEmpty: !mine.has(productId),
          },
          actor,
        );
        mine.add(productId);
      } catch (error) {
        if (!(error instanceof GalleryTakenError)) throw error;
        taken += 1;
      }
    },
    // The service is called directly, never through the HTTP upload limit.
    removeImage: async () => undefined,
    retryAfterMs: () => null,
    errorText: (error) => (error instanceof Error ? error.message : String(error)),
    stopped: () => stopRequested,
  });

  const tally = (result: PhotoResult) => outcomes.filter((outcome) => outcome.result === result).length;
  const result: CataloguePhotosResult = {
    files: names.length,
    attached: tally('imported') - taken,
    skipped: tally('skipped') + taken,
    failed: tally('failed'),
  };

  for (const outcome of outcomes) {
    if (outcome.result === 'failed') log.warn(`Catalogue photo ${outcome.row.fileName}: ${outcome.error}`);
  }
  log.info(
    `Catalogue photos: ${result.attached} attached, ${result.skipped} skipped, ${result.failed} failed, of ${result.files}` +
      (stopRequested ? ' (stopped for a restore)' : ''),
  );

  // Stopped, it is not the one run: the restore that stopped it decides what comes next.
  if (!stopRequested) {
    await db().transaction((trx) =>
      settingsRepo.upsertSetting(tenantId, CATALOGUE_PHOTOS_MARKER, { ...result, at: new Date().toISOString() }, false, 1, null, trx),
    );
  }
  return result;
}
