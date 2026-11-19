/**
 * 1.5.9's one-time reset (owner, 2026-11-19; `shared/src/domain/release-reset.ts`).
 *
 * The migration only marks a company `pending`; nothing is deleted at install, and the Master
 * runs on the migrated data until an administrator reads the written warning and confirms with
 * a tick and their own password. Then, in order:
 *
 *  1. Maintenance: Office sockets are closed and refused, HTTP writes wait (`backup-job.ts`).
 *  2. A **full backup** (database and every upload, photos included) into
 *     `<dataDir>/pre-1.5.9-reset/` — written and verified before anything is deleted; if it
 *     fails, nothing is deleted.
 *  3. One transaction: every order, lead and their lines, notes, stock rows, conflicts and
 *     links; every sub product, main product, photo row and party-product link
 *     (`clearCatalogueData`); print jobs and bell entries about orders. The row turns `done`
 *     with a new `epoch`. Parties, users, settings, option lists and the activity log stay; the
 *     order number counters are not touched, so a number already on paper is never reused.
 *  4. The photo files (avatars kept), then fresh caches and a new boot id, so every Office
 *     takes a full snapshot carrying the epoch and drops its unsent orders.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  RELEASE_RESET_VERSION,
  type ReleaseResetConfirmInput,
  type ReleaseResetResult,
  type ReleaseResetStatus,
} from '@orderbook/shared';

import { config } from '../config/index.js';
import { db } from '../db/knex.js';
import { assertAdminTier } from '../domain/access.js';
import { requirePermission, type ActorContext } from '../domain/actor.js';
import { ValidationError } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { verifyPassword } from '../lib/password.js';
import { panelLink } from '../realtime/panel-link.js';
import * as activityLog from '../repositories/activity-log.repository.js';
import * as userRepo from '../repositories/user.repository.js';
import { exportArchive } from './archive-export.service.js';
import { enterMaintenance, isJobRunning, leaveMaintenance, maintenanceError } from './backup-job.js';
import { clearCatalogueData } from './catalogue-seed.service.js';
import { publishChange } from './change-bus.js';
import { resetProcessCaches } from './process-caches.js';

const log = createLogger('release-reset');

const TABLE = 'release_resets';
/** Where the backup taken just before the reset goes. */
export const releaseResetBackupDir = (): string =>
  path.join(config.dataDir, `pre-${RELEASE_RESET_VERSION}-reset`);

interface ResetRow {
  status: 'pending' | 'done';
  epoch: string | null;
  backup_path: string | null;
  confirmed_at: Date | string | null;
}

function assertMayReset(actor: ActorContext): void {
  requirePermission(actor, 'settings.manage');
  assertAdminTier(actor, 'settings.manage');
}

async function readRow(tenantId: string): Promise<ResetRow | null> {
  const row = (await db()(TABLE)
    .where({ tenant_id: tenantId, release: RELEASE_RESET_VERSION })
    .first('status', 'epoch', 'backup_path', 'confirmed_at')) as ResetRow | undefined;
  return row ?? null;
}

async function count(table: string, tenantId: string): Promise<number> {
  const [row] = await db()(table)
    .where({ tenant_id: tenantId })
    .count<Array<{ count: string | number }>>('* as count');
  return Number(row?.count ?? 0);
}

/** The epoch a snapshot carries once this company's reset is done; null before. */
export async function resetEpochFor(tenantId: string): Promise<string | null> {
  const row = await readRow(tenantId).catch(() => null);
  return row?.status === 'done' ? row.epoch : null;
}

export async function releaseResetStatus(actor: ActorContext): Promise<ReleaseResetStatus> {
  assertMayReset(actor);
  const tenantId = actor.tenantId;
  const row = await readRow(tenantId);
  const [leads, orders, subProducts, mainProducts, photos, parties, users] = await Promise.all([
    count('leads', tenantId),
    count('orders', tenantId),
    count('products', tenantId),
    count('product_categories', tenantId),
    count('product_images', tenantId),
    count('parties', tenantId),
    count('users', tenantId),
  ]);
  return {
    release: RELEASE_RESET_VERSION,
    state: row?.status ?? 'none',
    removes: { newOrders: leads, finalOrders: orders, subProducts, mainProducts, photos },
    keeps: { parties, users },
    backupPath: row?.backup_path ?? null,
    confirmedAt: row?.confirmed_at ? new Date(row.confirmed_at).toISOString() : null,
  };
}

/** Removes this company's product photo folders; the avatars folder beside them stays. */
async function removePhotoFiles(tenantId: string): Promise<void> {
  const tenantDir = path.join(config.imagesDir, tenantId);
  const entries = await fs.readdir(tenantDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'avatars') continue;
    // Best effort: an orphan left behind is swept at the next boot (`sweepOrphanImageVariants`).
    await fs.rm(path.join(tenantDir, entry.name), { recursive: true, force: true }).catch((error: unknown) => {
      log.warn(`Could not remove photo folder ${entry.name}: ${String(error)}`);
    });
  }
}

export async function confirmReleaseReset(
  input: ReleaseResetConfirmInput,
  actor: ActorContext,
): Promise<ReleaseResetResult> {
  assertMayReset(actor);
  if (input.understood !== true) {
    throw new ValidationError('validation.releaseReset.notUnderstood', {}, { field: 'understood' });
  }
  const credential = actor.userId ? await userRepo.readCredentialById(actor.tenantId, actor.userId) : null;
  const { matches } = await verifyPassword(input.confirmPassword ?? '', credential?.passwordHash ?? null);
  if (!matches) {
    throw new ValidationError('validation.dataReset.passwordIncorrect', {}, { field: 'confirmPassword' });
  }

  const tenantId = actor.tenantId;
  const row = await readRow(tenantId);
  if (row?.status !== 'pending') {
    throw new ValidationError('validation.releaseReset.notPending');
  }
  // A backup or restore already holds the database; the reset needs it to itself.
  if (isJobRunning()) throw maintenanceError();

  await enterMaintenance();
  try {
    const folder = releaseResetBackupDir();
    await fs.mkdir(folder, { recursive: true });
    // Written and verified before anything is deleted: if this throws, nothing is.
    const backup = await exportArchive({ folder, includeUploads: true, actor });
    log.warn(`${RELEASE_RESET_VERSION} reset: backup written to ${backup.path}`);

    const epoch = randomUUID();
    const removed = await db().transaction(async (trx) => {
      await trx.raw(
        'LOCK TABLE leads, orders, line_items, products, product_categories, product_images IN EXCLUSIVE MODE',
      );
      const scoped = (table: string) => trx(table).where({ tenant_id: tenantId });
      const [subProducts, mainProducts] = await Promise.all([
        scoped('products').count<Array<{ count: string | number }>>('* as count'),
        scoped('product_categories').count<Array<{ count: string | number }>>('* as count'),
      ]);

      // What `clearCatalogueData` leaves: print jobs, bell entries and connector links that
      // name an order. Removed first; nothing references them.
      await scoped('print_jobs').whereIn('source_type', ['lead', 'order']).delete();
      await scoped('user_notifications').whereRaw("link->>'kind' = 'lead'").delete();
      await scoped('api_connector_links').whereIn('entity', ['lead', 'order']).delete();
      const { removedLeads, removedOrders } = await clearCatalogueData(tenantId, trx);

      await trx(TABLE)
        .where({ tenant_id: tenantId, release: RELEASE_RESET_VERSION })
        .update({
          status: 'done',
          epoch,
          backup_path: backup.path,
          confirmed_by: actor.userId ?? null,
          confirmed_at: trx.fn.now(),
        });

      const counts = {
        newOrders: removedLeads,
        finalOrders: removedOrders,
        subProducts: Number(subProducts[0]?.count ?? 0),
        mainProducts: Number(mainProducts[0]?.count ?? 0),
      };
      await activityLog.recordActivity(
        {
          tenantId,
          entityType: 'catalog',
          entityId: tenantId,
          action: 'erased',
          actorType: actor.actorType,
          actorId: actor.actorId,
          details: { release: RELEASE_RESET_VERSION, backup: backup.path, ...counts },
        },
        actor,
        trx,
      );
      return counts;
    });

    await removePhotoFiles(tenantId);
    log.warn(
      `${RELEASE_RESET_VERSION} reset by ${actor.actorName ?? actor.actorId ?? 'unknown'}: ` +
        `${removed.newOrders} new orders, ${removed.finalOrders} final orders, ` +
        `${removed.subProducts} sub products, ${removed.mainProducts} products`,
    );

    // A new boot id: every Office's cursor stops matching, so each takes a full snapshot,
    // which now carries the epoch. Master screens read again on the change events.
    resetProcessCaches();
    publishChange({ entity: 'catalog', action: 'deleted', id: tenantId, payload: { ...removed } });
    publishChange({ entity: 'party_bulk', action: 'deleted', id: tenantId, payload: { ...removed } });
    panelLink()?.resnapshotAll?.();

    return { ok: true, backupPath: backup.path, removed };
  } finally {
    leaveMaintenance();
  }
}
