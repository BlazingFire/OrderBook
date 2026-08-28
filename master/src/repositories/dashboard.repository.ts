/**
 * Dashboard-only queries (`docs/backend-modules/04-API-CONTRACT.md` §7.1).
 * `countRecentMutations` moves here from `dashboard.service.ts`, which
 * called `db()` directly — the one standing violation of decision 12 the
 * spec calls out by name.
 */

import type { Knex } from 'knex';

import { config } from '../config/index.js';
import { db } from '../db/knex.js';
import type { PartyScope } from '../domain/party-scope.js';
import { applyPartyScope, partyScopeSql } from './party-access.repository.js';
import { firstCount, toRequiredNumber } from './mappers.js';

type Runner = Knex | Knex.Transaction;

export interface StageLeadCount {
  stageId: string;
  stageName: string;
  sequence: number;
  colourHex: string | null;
  leadCount: number;
}

/** Live, unconverted leads grouped by stage, for the tenant's lead pipeline — every stage present, even at zero. */
export async function leadCountsByStage(
  tenantId: string,
  scope: PartyScope,
  runner: Runner = db(),
): Promise<StageLeadCount[]> {
  // The scope goes in the LEFT JOIN's ON clause, not the WHERE: moving it to
  // the WHERE would drop every stage whose only leads are out of scope, and a
  // board that silently loses a column reads as a broken pipeline rather than
  // as an empty one.
  const partyScope = partyScopeSql('l.party_id', tenantId, scope);

  const { rows } = await runner.raw<{
    rows: Array<{ stage_id: string; stage_name: string; sequence: number; colour: string | null; lead_count: string }>;
  }>(
    `SELECT s.id AS stage_id, s.name AS stage_name, s.sequence, s.colour,
            count(l.id) FILTER (WHERE l.id IS NOT NULL) AS lead_count
       FROM pipeline_stages s
       JOIN pipelines p ON p.id = s.pipeline_id AND p.kind = 'lead'
       LEFT JOIN leads l
         ON l.stage_id = s.id AND l.tenant_id = ? AND l.deleted_at IS NULL AND l.converted_order_id IS NULL${partyScope.sql}
      WHERE p.tenant_id = ?
      GROUP BY s.id, s.name, s.sequence, s.colour
      ORDER BY s.sequence`,
    [tenantId, ...partyScope.bindings, tenantId],
  );

  return rows.map((row) => ({
    stageId: row.stage_id,
    stageName: row.stage_name,
    sequence: toRequiredNumber(row.sequence),
    colourHex: row.colour,
    leadCount: toRequiredNumber(row.lead_count),
  }));
}

/**
 * Dispatched since the start of the current business week. The boundary is
 * computed **in SQL against `config.locale.timeZone`** — a week that starts
 * at UTC midnight starts at 05:30 IST, which would put an early-morning
 * dispatch in the wrong week.
 */
export async function dispatchedThisWeek(
  tenantId: string,
  scope: PartyScope,
  runner: Runner = db(),
): Promise<number> {
  const tz = config.locale.timeZone;
  const query = runner('orders')
    .where({ tenant_id: tenantId })
    .whereNull('deleted_at')
    .andWhereRaw('dispatched_at >= (date_trunc(\'week\', now() AT TIME ZONE ?) AT TIME ZONE ?)', [tz, tz]);

  applyPartyScope(query, tenantId, 'orders.party_id', scope, { level: 'view' });

  const rows = await query.count<Array<{ count: string }>>('id as count');
  return firstCount(rows);
}

export async function openOrderCount(
  tenantId: string,
  scope: PartyScope,
  runner: Runner = db(),
): Promise<number> {
  const query = runner('orders')
    .where({ tenant_id: tenantId })
    .whereNull('deleted_at')
    .whereNull('dispatched_at');

  applyPartyScope(query, tenantId, 'orders.party_id', scope, { level: 'view' });

  const rows = await query.count<Array<{ count: string }>>('id as count');
  return firstCount(rows);
}

/**
 * Mutations that arrived from panels in the last hour — a proxy for sync
 * health, not a true "pending" count. The Master cannot see what is still
 * sitting in a disconnected panel's outbox.
 */
export async function countRecentMutations(tenantId: string, runner: Runner = db()): Promise<number> {
  const rows = await runner('applied_mutations')
    .where({ tenant_id: tenantId })
    .andWhere('applied_at', '>=', runner.raw("now() - interval '1 hour'"))
    .count<Array<{ count: string }>>('mutation_id as count');
  return firstCount(rows);
}
