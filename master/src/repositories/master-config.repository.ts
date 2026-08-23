import type { Knex } from 'knex';

import { db } from '../db/knex.js';

export interface MasterConfigRow {
  id: number;
  tenant_id: string;
  master_unique_id: string;
  company_name: string | null;
  lan_ip: string;
  port: number;
  pairing_password_hash: string;
  setup_completed_at: Date;
}

const TABLE = 'master_config';

export async function findMasterConfig(): Promise<MasterConfigRow | null> {
  const row = await db()<MasterConfigRow>(TABLE).where({ id: 1 }).first();
  return row ?? null;
}

export async function isSetupComplete(): Promise<boolean> {
  return (await findMasterConfig()) !== null;
}

export async function insertMasterConfig(
  values: Omit<MasterConfigRow, 'id'>,
  trx?: Knex.Transaction,
): Promise<MasterConfigRow> {
  const query = (trx ?? db())<MasterConfigRow>(TABLE)
    .insert({ ...values, id: 1 })
    .returning('*');
  const [row] = await query;
  if (!row) throw new Error('Failed to persist master configuration');
  return row;
}

export async function updateLanIp(lanIp: string): Promise<void> {
  await db()(TABLE).where({ id: 1 }).update({ lan_ip: lanIp, updated_at: db().fn.now() });
}
