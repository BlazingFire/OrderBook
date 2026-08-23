import { db } from '../db/knex.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('activity');

export type ActorType = 'user' | 'office_panel' | 'system';

export interface ActivityEntry {
  tenantId: string;
  entityType: string;
  entityId: string;
  action: string;
  actorType: ActorType;
  actorId: string | null;
  details?: Record<string, unknown>;
}

/**
 * Audit writes must never break the operation they describe — an order that
 * saved successfully should not fail because its log row could not be written.
 *
 * The failure is **logged**, not swallowed silently. An earlier version simply
 * discarded it, and when the tenancy migration made `tenant_id` NOT NULL every
 * insert began failing with nothing to show for it: the audit trail was empty
 * and nothing anywhere said so. A best-effort write still has to be honest
 * about not happening.
 */
export async function recordActivity(entry: ActivityEntry): Promise<void> {
  try {
    await db()('activity_log').insert({
      tenant_id: entry.tenantId,
      entity_type: entry.entityType,
      entity_id: entry.entityId,
      action: entry.action,
      actor_type: entry.actorType,
      actor_id: entry.actorId,
      details: entry.details ? JSON.stringify(entry.details) : null,
    });
  } catch (error) {
    log.warn(
      `Could not record ${entry.action} on ${entry.entityType} ${entry.entityId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
