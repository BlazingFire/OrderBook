import type { OfficePanel, OfficePanelStatus } from '@orderbook/shared';

import { db } from '../db/knex.js';
import { mapOfficePanel } from './mappers.js';

const TABLE = 'office_panels';

export async function listPanels(tenantId: string): Promise<OfficePanel[]> {
  const rows = await db()(TABLE).where({ tenant_id: tenantId }).orderBy('created_at', 'desc');
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
  tenant_id: string;
  name: string;
  device_code: string;
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

/** Written on connect, and only when it has changed — see the caller. */
export async function updatePanelAppVersion(id: string, appVersion: string): Promise<OfficePanel | null> {
  const [row] = await db()(TABLE)
    .where({ id })
    .update({ app_version: appVersion, updated_at: db().fn.now() })
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

export async function countPanelsNamed(tenantId: string, prefix: string): Promise<number> {
  const row = await db()(TABLE)
    .where({ tenant_id: tenantId })
    .whereILike('name', `${prefix}%`)
    .count<Array<{ count: string }>>('id as count');
  return Number(row[0]?.count ?? 0);
}

/** Which role a panel's commands act under. Null means the seeded Office role. */
export async function findPanelRoleId(id: string): Promise<string | null> {
  const row = await db()(TABLE).select('role_id').where({ id }).first();
  return (row?.role_id as string | null) ?? null;
}
