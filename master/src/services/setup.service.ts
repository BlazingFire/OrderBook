/**
 * First-run setup: generates the Master's identity, creates the owner's two
 * Server Master accounts, and hands back what an operator needs to pair Office
 * Panels.
 *
 * The owner types both Server Master accounts; nothing creates an `admin` any
 * more. The pairing password is generated, shown exactly once on the first-run
 * screen, and only its hash is stored.
 */

import { randomBytes } from 'node:crypto';
import { SERVER_MASTER_MIN_ACTIVE, type MasterIdentity } from '@orderbook/shared';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';

import { config } from '../config/index.js';
import { db } from '../db/knex.js';
import { systemActor } from '../domain/actor.js';
import { ConflictError } from '../lib/errors.js';
import { listLanAddresses, primaryLanAddress } from '../lib/network.js';
import * as activityLog from '../repositories/activity-log.repository.js';
import { findMasterConfig, insertMasterConfig, updateLanIp } from '../repositories/master-config.repository.js';
import { resolveDefaultTenantId } from '../repositories/tenant.repository.js';
import {
  createServerMasters,
  prepareServerMasters,
  rememberServerMasters,
  serverMastersNeeded,
} from './server-master.service.js';

const BCRYPT_ROUNDS = 10;

export interface FirstRunCredentials {
  masterUniqueId: string;
  /** The two Server Masters as created. Their passwords were typed by the owner and are not echoed. */
  accounts: Array<{ username: string; displayName: string }>;
  /** Plaintext, shown once; used by Office Panels doing manual pairing. */
  pairingPassword: string;
  lanIps: string[];
  port: number;
}

export async function isSetupComplete(): Promise<boolean> {
  return (await findMasterConfig()) !== null;
}

/** `GET /api/setup/status`: the company name appears only once setup is done. */
export async function getSetupStatus(): Promise<{ setupComplete: boolean; companyName?: string | null }> {
  const row = await findMasterConfig();
  return row ? { setupComplete: true, companyName: row.company_name } : { setupComplete: false };
}

/**
 * Whether this installation still owes its owner two Server Master accounts:
 * set up before the tier existed, or restored from a backup that was. The
 * Master-PC sign-in screen then opens the master-key setup flow first.
 */
export async function serverMasterSetupNeeded(): Promise<boolean> {
  return (await serverMastersNeeded()) > 0;
}

export async function runFirstTimeSetup(
  companyName: string | null,
  accounts: unknown,
): Promise<FirstRunCredentials> {
  if (await isSetupComplete()) {
    throw new ConflictError('error.conflict.alreadySetUp');
  }

  // Validated and hashed before the transaction, so a short password is
  // refused without anything having been written.
  const serverMasters = await prepareServerMasters(accounts, SERVER_MASTER_MIN_ACTIVE);

  const masterUniqueId = uuid();
  const pairingPassword = generateReadableSecret();
  const lanIps = listLanAddresses();
  const pairingHash = await bcrypt.hash(pairingPassword, BCRYPT_ROUNDS);

  const seeded = await db().transaction(async (trx) => {
    // The tenancy migration seeds the tenant and its roles, so setup looks
    // them up rather than inventing a second set.
    const tenantId = await resolveDefaultTenantId(trx);
    const actor = systemActor(tenantId);

    const created = await createServerMasters(tenantId, serverMasters, actor, trx);

    await insertMasterConfig(
      {
        tenant_id: tenantId,
        master_unique_id: masterUniqueId,
        company_name: companyName,
        lan_ip: lanIps[0] ?? '127.0.0.1',
        port: config.http.port,
        pairing_password_hash: pairingHash,
        setup_completed_at: new Date(),
      },
      trx,
    );

    // Last in the transaction, like every other audited write.
    await activityLog.recordActivity(
      {
        tenantId,
        entityType: 'master_config',
        entityId: masterUniqueId,
        action: 'set_up',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { companyName: companyName ?? '' },
      },
      actor,
      trx,
    );

    return { tenantId, actor, created };
  });

  // Wired for completeness and a no-op on every fresh install: the password
  // vault's switch defaults to off. Sealed after the transaction so the
  // fingerprint is taken from the hash actually on disk.
  await rememberServerMasters(seeded.tenantId, seeded.created, serverMasters, seeded.actor);

  return {
    masterUniqueId,
    accounts: seeded.created.map(({ username, displayName }) => ({ username, displayName })),
    pairingPassword,
    lanIps,
    port: config.http.port,
  };
}

export async function getIdentity(): Promise<MasterIdentity | null> {
  const row = await findMasterConfig();
  if (!row) return null;

  return {
    masterUniqueId: row.master_unique_id,
    tenantId: row.tenant_id ?? (await resolveDefaultTenantId()),
    companyName: row.company_name,
    lanIps: listLanAddresses(),
    // The port this process listens on, not the one stored at setup: they differ when it was started with another PORT.
    port: config.http.port,
    setupCompletedAt: row.setup_completed_at.toISOString(),
  };
}

export async function verifyPairingPassword(candidate: string): Promise<boolean> {
  const row = await findMasterConfig();
  if (!row) return false;
  return bcrypt.compare(candidate, row.pairing_password_hash);
}

/**
 * DHCP can hand this PC a different address between runs; the stored value is
 * refreshed at startup so the setup screen never shows a stale IP.
 */
export async function refreshStoredLanIp(): Promise<void> {
  const current = primaryLanAddress();
  if (!current) return;

  const row = await findMasterConfig();
  if (row && row.lan_ip !== current) await updateLanIp(current);
}

/**
 * Ambiguous characters (0/O, 1/l/I) are excluded because these secrets get
 * read off one screen and typed into another by hand.
 */
/** Exported for reuse by `backup-restore.service.ts`, which mints a fresh pairing password on every restore. */
export function generateReadableSecret(length = 10): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[(bytes[i] ?? 0) % alphabet.length];
  }
  return out;
}
