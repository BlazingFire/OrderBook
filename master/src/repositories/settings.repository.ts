/**
 * Raw row access for the `settings` table.
 *
 * Nothing here interprets a value: parsing, sealing and the fallback for an
 * absent row all live in `services/settings.service.ts`, so there is exactly one
 * place that knows what a key means.
 */

import type { Knex } from 'knex';

import { db } from '../db/knex.js';
import type { TransactionContext } from './transaction.js';

type Runner = Knex | Knex.Transaction;

const TABLE = 'settings';

export interface SettingRow {
  key: string;
  value: unknown;
  isSecret: boolean;
  keyVersion: number;
  updatedAt: Date;
  updatedBy: string | null;
}

interface RawRow {
  key: string;
  value: unknown;
  is_secret: boolean;
  key_version: number;
  updated_at: Date;
  updated_by: string | null;
}

function map(row: RawRow): SettingRow {
  return {
    key: row.key,
    value: row.value,
    isSecret: row.is_secret,
    keyVersion: row.key_version,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

export async function readSettingRows(
  tenantId: string,
  runner: Runner = db(),
): Promise<SettingRow[]> {
  const rows = await runner(TABLE)
    .where({ tenant_id: tenantId })
    .select<RawRow[]>('key', 'value', 'is_secret', 'key_version', 'updated_at', 'updated_by');

  return rows.map(map);
}

export async function upsertSetting(
  tenantId: string,
  key: string,
  value: unknown,
  isSecret: boolean,
  keyVersion: number,
  actorId: string | null,
  trx: TransactionContext,
): Promise<void> {
  await trx(TABLE)
    .insert({
      tenant_id: tenantId,
      key,
      // Stringified rather than handed to the driver as an object: `pg` sends a
      // bare JS object to a JSONB column as a literal `[object Object]` unless
      // it is told otherwise, and a boolean `false` would arrive as the SQL
      // boolean rather than the JSON scalar.
      value: JSON.stringify(value ?? null),
      is_secret: isSecret,
      key_version: keyVersion,
      updated_at: new Date(),
      updated_by: actorId,
    })
    .onConflict(['tenant_id', 'key'])
    .merge(['value', 'is_secret', 'key_version', 'updated_at', 'updated_by']);
}
