import { db } from '../db/knex.js';

export type ActorType = 'user' | 'office_panel' | 'system';

export interface ActivityEntry {
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
 */
export async function recordActivity(entry: ActivityEntry): Promise<void> {
  try {
    await db()('activity_log').insert({
      entity_type: entry.entityType,
      entity_id: entry.entityId,
      action: entry.action,
      actor_type: entry.actorType,
      actor_id: entry.actorId,
      details: entry.details ? JSON.stringify(entry.details) : null,
    });
  } catch {
    // Intentionally swallowed; see comment above.
  }
}
