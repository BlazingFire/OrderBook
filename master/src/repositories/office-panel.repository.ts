import type { OfficePanel, OfficePanelStatus } from '@orderbook/shared';

import { db } from '../db/knex.js';
import { mapOfficePanel } from './mappers.js';

const TABLE = 'office_panels';

export async function listPanels(): Promise<OfficePanel[]> {
  const rows = await db()(TABLE).orderBy('created_at', 'desc');
  return rows.map(mapOfficePanel);
}

export async function findPanelById(id: string): Promise<OfficePanel | null> {
  const row = await db()(TABLE).where({ id }).first();
  return row ? mapOfficePanel(row) : null;
}

/** Secret hash is returned separately so it never leaks into a domain object. */
export async function findPanelSecretHash(id: string): Promise<string | null> {
  const row = await db()(TABLE).select('secret_hash').where({ id }).first();
  return row ? String(row.secret_hash) : null;
}

export async function insertPanel(values: {
  id: string;
  name: string;
  secret_hash: string;
  lan_ip: string | null;
  status: OfficePanelStatus;
  paired_at: Date;
}): Promise<OfficePanel> {
  const [row] = await db()(TABLE).insert(values).returning('*');
  return mapOfficePanel(row);
}

export async function updatePanelStatus(
  id: string,
  status: OfficePanelStatus,
): Promise<OfficePanel | null> {
  const [row] = await db()(TABLE)
    .where({ id })
    .update({ status, updated_at: db().fn.now() })
    .returning('*');
  return row ? mapOfficePanel(row) : null;
}

export async function renamePanel(id: string, name: string): Promise<OfficePanel | null> {
  const [row] = await db()(TABLE)
    .where({ id })
    .update({ name, updated_at: db().fn.now() })
    .returning('*');
  return row ? mapOfficePanel(row) : null;
}

export async function touchLastSeen(id: string, lanIp: string | null): Promise<void> {
  const patch: Record<string, unknown> = { last_seen_at: db().fn.now() };
  if (lanIp) patch.lan_ip = lanIp;
  await db()(TABLE).where({ id }).update(patch);
}

export async function countPanelsNamed(prefix: string): Promise<number> {
  const row = await db()(TABLE).count<{ count: string }[]>('id as count').whereILike('name', `${prefix}%`);
  return Number(row[0]?.count ?? 0);
}
