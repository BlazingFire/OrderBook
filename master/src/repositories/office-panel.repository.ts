import type {
  OfficePanel,
  OfficePanelReportInput,
  OfficePanelStatus,
} from '@orderbook/shared';
import type { Knex } from 'knex';

import { db } from '../db/knex.js';
import { mapOfficePanel } from './mappers.js';

const TABLE = 'office_panels';

/**
 * The writes an administrator makes take the caller's transaction, so each
 * commits with its audit entry (`panel.service.ts`); left out, they run on the
 * pool exactly as before.
 */
type Runner = Knex | Knex.Transaction;

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
}, runner: Runner = db()): Promise<OfficePanel> {
  const [row] = await runner(TABLE).insert(values).returning('*');
  return mapOfficePanel(row);
}

export async function updatePanelStatus(
  id: string,
  status: OfficePanelStatus,
  runner: Runner = db(),
): Promise<OfficePanel | null> {
  const [row] = await runner(TABLE)
    .where({ id })
    .update({ status, updated_at: runner.fn.now() })
    .returning('*');
  return row ? mapOfficePanel(row) : null;
}

export async function renamePanel(
  id: string,
  name: string,
  runner: Runner = db(),
): Promise<OfficePanel | null> {
  const [row] = await runner(TABLE)
    .where({ id })
    .update({ name, updated_at: runner.fn.now() })
    .returning('*');
  return row ? mapOfficePanel(row) : null;
}

export async function touchLastSeen(id: string, lanIp: string | null): Promise<void> {
  const patch: Record<string, unknown> = { last_seen_at: db().fn.now() };
  if (lanIp) patch.lan_ip = lanIp;
  await db()(TABLE).where({ id }).update(patch);
}

/**
 * Store what a panel last said about its own machine.
 *
 * `device_reported_at` is stamped from the Master's clock, never from the
 * payload: a panel whose PC has the wrong date must not be able to claim its
 * figures are newer than they are, and every "as of" on the administration
 * screen is read against the Master's own time.
 */
export async function updateDeviceReport(
  id: string,
  report: OfficePanelReportInput,
): Promise<OfficePanel | null> {
  const [row] = await db()(TABLE)
    .where({ id })
    .update({
      hostname: report.hostname,
      platform: report.platform,
      os_version: report.osVersion,
      app_version: report.appVersion,
      node_version: report.nodeVersion,
      data_dir: report.dataDir,
      images_dir: report.imagesDir,
      storage_bytes: report.storageBytes,
      disk_free_bytes: report.diskFreeBytes,
      disk_total_bytes: report.diskTotalBytes,
      local_port: report.localPort,
      panel_started_at: report.startedAt ? new Date(report.startedAt) : null,
      device_reported_at: db().fn.now(),
      updated_at: db().fn.now(),
    })
    .returning('*');
  return row ? mapOfficePanel(row) : null;
}

/** Replaces the stored bcrypt hash. `secret_rotated_at` is what dates the change. */
export async function updatePanelSecretHash(
  id: string,
  secretHash: string,
): Promise<OfficePanel | null> {
  const [row] = await db()(TABLE)
    .where({ id })
    .update({ secret_hash: secretHash, secret_rotated_at: db().fn.now(), updated_at: db().fn.now() })
    .returning('*');
  return row ? mapOfficePanel(row) : null;
}

export async function updatePanelNotes(
  id: string,
  notes: string | null,
  runner: Runner = db(),
): Promise<OfficePanel | null> {
  const [row] = await runner(TABLE)
    .where({ id })
    .update({ notes, updated_at: runner.fn.now() })
    .returning('*');
  return row ? mapOfficePanel(row) : null;
}

/** `null` returns the panel to the seeded Office role — see `permissionsForPanel`. */
export async function assignPanelRole(
  id: string,
  roleId: string | null,
  runner: Runner = db(),
): Promise<OfficePanel | null> {
  const [row] = await runner(TABLE)
    .where({ id })
    .update({ role_id: roleId, updated_at: runner.fn.now() })
    .returning('*');
  return row ? mapOfficePanel(row) : null;
}

/**
 * What this panel has actually raised, so a panel nobody uses is visible as
 * such before somebody unplugs the wrong PC.
 *
 * Counts soft-deleted records too: they were still this panel's work, and
 * excluding them would make a panel look idle because somebody tidied up.
 */
export async function countWorkFromPanel(
  tenantId: string,
  panelId: string,
): Promise<{ leads: number; orders: number; lastActionAt: string | null }> {
  const [leads, orders, lastAction] = await Promise.all([
    db()('leads')
      .where({ tenant_id: tenantId, source_panel_id: panelId })
      .count<Array<{ count: string }>>('id as count'),
    db()('orders')
      .where({ tenant_id: tenantId, source_panel_id: panelId })
      .count<Array<{ count: string }>>('id as count'),
    db()('activity_log')
      .where({ tenant_id: tenantId, actor_type: 'office_panel', actor_id: panelId })
      .max<Array<{ max: Date | null }>>('created_at as max'),
  ]);

  const at = lastAction[0]?.max ?? null;
  return {
    leads: Number(leads[0]?.count ?? 0),
    orders: Number(orders[0]?.count ?? 0),
    lastActionAt: at ? new Date(at).toISOString() : null,
  };
}

/**
 * The names already in use under a prefix, for minting the next default.
 *
 * This replaced a `count`, which was wrong in a way nobody would notice until
 * it mattered: pair two panels ("Office Panel 1", "Office Panel 2"), rename the
 * first to "Reception", and the count of `Office Panel%` is 1 again — so the
 * next auto-paired panel is also named "Office Panel 2". Nothing enforces name
 * uniqueness (only `(tenant_id, device_code)` is unique, and `updatePanel`
 * checks nothing), so the duplicate simply exists, on the exact screen an
 * administrator uses to decide which panel to revoke or which PC to walk to.
 */
export async function panelNamesMatching(tenantId: string, prefix: string): Promise<string[]> {
  const rows = await db()(TABLE)
    .select('name')
    .where({ tenant_id: tenantId })
    .whereILike('name', `${prefix}%`);
  return rows.map((row) => String((row as { name: unknown }).name));
}

/** Which role a panel's commands act under. Null means the seeded Office role. */
export async function findPanelRoleId(id: string): Promise<string | null> {
  const row = await db()(TABLE).select('role_id').where({ id }).first();
  return (row?.role_id as string | null) ?? null;
}
