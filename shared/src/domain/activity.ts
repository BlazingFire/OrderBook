/**
 * Logs' read-side wire types (`docs/backend-modules/04-API-CONTRACT.md` §2.1)
 * — the counterpart to the Master-internal `ActivityEntry`
 * (`master/src/repositories/activity-log.repository.ts`), which stays a
 * write-side type in the repository.
 *
 * `id` and `sequence` are declared `string`, not `number`: node-postgres
 * returns BIGINT as a string, and a cursor built with `Number()` loses
 * precision past 2^53.
 */

import type { IsoTimestamp, RecordId, Uuid } from './entities.js';
import type { CursorQuery } from './inputs.js';

export type ActivityActorType = 'user' | 'office_panel' | 'system' | 'api_key' | 'connector';

export interface ActivityActor {
  type: ActivityActorType;
  id: RecordId | null;
  /** Denormalised at write time, so a deleted user's name still renders. */
  name: string | null;
}

export interface ActivityLogEntry {
  id: string;
  /** BIGINT as TEXT; `null` on a pre-chain row. */
  sequence: string | null;
  tenantId: Uuid;
  entityType: string;
  entityId: string;
  action: string;
  actor: ActivityActor;
  details: Record<string, unknown>;
  createdAt: IsoTimestamp;
  /**
   * This entry's own sha256, hex, as stored. `null` on a backfilled
   * pre-chain row — what `chained: false` says in words. Covered by
   * `logs.view` like every other field here.
   */
  hash: string | null;
  /** False for backfilled pre-chain rows: unverifiable, not broken. */
  chained: boolean;
}

export interface ActivityLogQuery extends CursorQuery {
  actorType?: ActivityActorType;
  actorId?: string;
  entityType?: string;
  action?: string;
  /** 'YYYY-MM-DD', inclusive. */
  from?: string;
  /** 'YYYY-MM-DD', inclusive. */
  to?: string;
  /** Free text over entity_id and details::text. */
  q?: string;
}

export interface ActivityLogFacets {
  actors: ActivityActor[];
  entityTypes: string[];
  actions: string[];
}

export type ChainBreakKind = 'hash_mismatch' | 'prev_hash_mismatch' | 'sequence_gap';

export interface ChainBreak {
  kind: ChainBreakKind;
  sequence: string;
  id: string;
  createdAt: IsoTimestamp;
}

export interface ChainVerification {
  ok: boolean;
  checkedCount: number;
  skippedPreChainCount: number;
  fromSequence: string | null;
  toSequence: string | null;
  firstBreak: ChainBreak | null;
  truncated: boolean;
}

export interface ChainVerifyInput {
  fromSequence?: string;
  toSequence?: string;
  limit?: number;
}
