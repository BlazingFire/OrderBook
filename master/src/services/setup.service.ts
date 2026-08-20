/**
 * First-run setup: generates the Master's identity and the credentials an
 * operator needs to sign in and to pair Office Panels.
 *
 * Secrets are shown exactly once, on the first-run screen, and only their
 * hashes are stored.
 */

import { randomBytes } from 'node:crypto';
import type { MasterIdentity } from '@orderbook/shared';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';

import { config } from '../config/index.js';
import { db } from '../db/knex.js';
import { ConflictError } from '../lib/errors.js';
import { listLanAddresses, primaryLanAddress } from '../lib/network.js';
import { findMasterConfig, insertMasterConfig, updateLanIp } from '../repositories/master-config.repository.js';
import { insertUser } from '../repositories/user.repository.js';

const BCRYPT_ROUNDS = 10;

export interface FirstRunCredentials {
  masterUniqueId: string;
  username: string;
  /** Plaintext, shown once on the setup screen and never persisted. */
  password: string;
  /** Plaintext, shown once; used by Office Panels doing manual pairing. */
  pairingPassword: string;
  lanIps: string[];
  port: number;
}

export async function isSetupComplete(): Promise<boolean> {
  return (await findMasterConfig()) !== null;
}

export async function runFirstTimeSetup(companyName: string | null): Promise<FirstRunCredentials> {
  if (await isSetupComplete()) {
    throw new ConflictError('This Master Panel has already been set up');
  }

  const masterUniqueId = uuid();
  const username = 'admin';
  const password = generateReadableSecret();
  const pairingPassword = generateReadableSecret();
  const lanIps = listLanAddresses();

  const [passwordHash, pairingHash] = await Promise.all([
    bcrypt.hash(password, BCRYPT_ROUNDS),
    bcrypt.hash(pairingPassword, BCRYPT_ROUNDS),
  ]);

  await db().transaction(async (trx) => {
    await insertUser(
      {
        id: uuid(),
        username,
        password_hash: passwordHash,
        full_name: 'Administrator',
        role: 'admin',
      },
      trx,
    );

    await insertMasterConfig(
      {
        master_unique_id: masterUniqueId,
        company_name: companyName,
        lan_ip: lanIps[0] ?? '127.0.0.1',
        port: config.http.port,
        pairing_password_hash: pairingHash,
        setup_completed_at: new Date(),
      },
      trx,
    );
  });

  return { masterUniqueId, username, password, pairingPassword, lanIps, port: config.http.port };
}

export async function getIdentity(): Promise<MasterIdentity | null> {
  const row = await findMasterConfig();
  if (!row) return null;

  return {
    masterUniqueId: row.master_unique_id,
    companyName: row.company_name,
    lanIps: listLanAddresses(),
    port: row.port,
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
function generateReadableSecret(length = 10): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[(bytes[i] ?? 0) % alphabet.length];
  }
  return out;
}
