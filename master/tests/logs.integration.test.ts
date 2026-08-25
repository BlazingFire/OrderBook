/**
 * Logs against a real cluster: keyset pagination both directions, filters,
 * facets, actor-name survival after the user is soft-deleted, and chain
 * verification including a deliberately tampered row and a pre-chain row.
 * `docs/backend-modules/10-TESTING.md` §6.5 owns the gate list this suite
 * answers (`LOG-1`…`LOG-15`).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ActorContext } from '../src/domain/actor.js';
import { db } from '../src/db/knex.js';
import { ValidationError } from '../src/lib/errors.js';
import * as catalogService from '../src/services/catalog.service.js';
import * as fieldsService from '../src/services/fields.service.js';
import * as logService from '../src/services/log.service.js';
import * as userService from '../src/services/user.service.js';
import { canRunIntegrationTests } from './helpers/db.js';
import { actorWith, resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';

let actor: ActorContext;

describe.skipIf(!canRunIntegrationTests)('Logs (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    actor = await testActor();
  });

  describe('listing', () => {
    it('LOG-1: pages newest-first and returns the same rows walking Older then Newer back', async () => {
      for (let i = 0; i < 5; i += 1) {
        await catalogService.createParty({ name: `Log Party ${i}` }, actor);
      }

      const first = await logService.listLogs({ limit: 2 }, actor);
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();

      const second = await logService.listLogs({ cursor: first.nextCursor ?? undefined, limit: 2 }, actor);
      expect(second.items).toHaveLength(2);
      // Second page continues strictly older than the first.
      expect(BigInt(second.items[0]!.id)).toBeLessThan(BigInt(first.items.at(-1)!.id));

      const back = await logService.listLogs(
        { cursor: second.prevCursor ?? undefined, direction: 'newer', limit: 2 },
        actor,
      );
      expect(back.items.map((e) => e.id)).toEqual(first.items.map((e) => e.id).slice(-back.items.length));
    });

    it('LOG-3: a malformed cursor is rejected rather than silently restarting at the newest page', async () => {
      await expect(logService.listLogs({ cursor: 'not-a-cursor' }, actor)).rejects.toBeInstanceOf(
        ValidationError,
      );
    });

    it('LOG-4: filters by entity type, action and free text', async () => {
      const party = await catalogService.createParty({ name: 'Filter Target' }, actor);
      await catalogService.createParty({ name: 'Other Party' }, actor);

      const byEntity = await logService.listLogs({ entityType: 'party' }, actor);
      expect(byEntity.items.every((e) => e.entityType === 'party')).toBe(true);

      const byAction = await logService.listLogs({ entityType: 'party', action: 'created' }, actor);
      expect(byAction.items.every((e) => e.action === 'created')).toBe(true);

      const byText = await logService.listLogs({ q: party.id }, actor);
      expect(byText.items.some((e) => e.entityId === party.id)).toBe(true);
    });

    it('LOG-5: actor name survives the user being soft-deleted', async () => {
      const role = await db()('roles').where({ tenant_id: actor.tenantId, tier: 'office' }).first('id');
      const { user, secret } = await userService.createUser(
        { username: 'log-user', displayName: 'Log User', roleId: role.id },
        actor,
      );
      void secret;

      const asUser = await testActor({ actorType: 'user', actorId: user.id, userId: user.id, actorName: user.displayName });
      await catalogService.createParty({ name: 'Created By Log User' }, asUser);

      await userService.deleteUser(user.id, actor);

      const logs = await logService.listLogs({ actorId: user.id }, actor);
      expect(logs.items.length).toBeGreaterThan(0);
      expect(logs.items[0]!.actor.name).toBe('Log User');
    });

    it('LOG-6: a row written after the migration carries actor_name', async () => {
      await catalogService.createParty({ name: 'Actor Name Party' }, actor);
      const row = await db()('activity_log')
        .where({ tenant_id: actor.tenantId, entity_type: 'party', action: 'created' })
        .orderBy('id', 'desc')
        .first('actor_name');
      expect(row.actor_name).toBe('Test Actor');
    });

    it('LOG-7: a system actor and a NULL actor_id row render without an empty cell throwing', async () => {
      await db()('activity_log').insert({
        tenant_id: actor.tenantId,
        entity_type: 'system',
        entity_id: 'boot',
        action: 'started',
        actor_type: 'system',
        actor_id: null,
        details: null,
      });

      const logs = await logService.listLogs({ entityType: 'system' }, actor);
      expect(logs.items[0]?.actor).toEqual({ type: 'system', id: null, name: null });
    });

    it('LOG-15: hash is populated and is string | null, covered by logs.view', async () => {
      await catalogService.createParty({ name: 'Hash Party' }, actor);
      const logs = await logService.listLogs({ entityType: 'party', action: 'created' }, actor);
      expect(logs.items[0]?.hash).toEqual(expect.any(String));
      expect(logs.items[0]?.chained).toBe(true);
    });

    it('LOG-14: refusals name the missing permission', async () => {
      const noLogs = await actorWith([]);
      await expect(logService.listLogs({}, noLogs)).rejects.toMatchObject({
        code: 'forbidden',
        details: { permission: 'logs.view' },
      });
    });
  });

  describe('facets', () => {
    it('populates from the data with no CHECK constraint to enumerate against', async () => {
      await catalogService.createParty({ name: 'Facet Party' }, actor);
      const facets = await logService.listLogFacets({}, actor);
      expect(facets.actions).toContain('created');
      expect(facets.entityTypes).toContain('party');
      expect(facets.actors.some((a) => a.name === 'Test Actor')).toBe(true);
    });
  });

  describe('chain verification', () => {
    it('LOG-10: reports ok over an untampered chain and counts the rows it checked', async () => {
      await catalogService.createParty({ name: 'Verify Party' }, actor);
      const result = await logService.verifyLogChain({}, actor);
      expect(result.ok).toBe(true);
      expect(result.checkedCount).toBeGreaterThan(0);
    });

    it('LOG-8: detects a tampered row and reports the first break and its sequence', async () => {
      await catalogService.createParty({ name: 'Tamper Party' }, actor);
      const row = await db()('activity_log')
        .where({ tenant_id: actor.tenantId, entity_type: 'party', action: 'created' })
        .orderBy('id', 'desc')
        .first('id', 'sequence');

      await db().raw('ALTER TABLE activity_log DISABLE TRIGGER activity_log_no_update');
      await db()('activity_log').where({ id: row.id }).update({ hash: 'deadbeef'.repeat(8) });
      await db().raw('ALTER TABLE activity_log ENABLE TRIGGER activity_log_no_update');

      const result = await logService.verifyLogChain({}, actor);
      expect(result.ok).toBe(false);
      expect(result.firstBreak).toMatchObject({ kind: 'hash_mismatch', sequence: String(row.sequence) });
    });

    it('LOG-9: reports a prev_hash break when a row is unlinked from its predecessor', async () => {
      await catalogService.createParty({ name: 'Unlink Party A' }, actor);
      await catalogService.createParty({ name: 'Unlink Party B' }, actor);
      const row = await db()('activity_log')
        .where({ tenant_id: actor.tenantId, entity_type: 'party', action: 'created' })
        .orderBy('id', 'desc')
        .first('id', 'sequence');

      // Faking `prev_hash` alone would also change what `activity_log_row_hash`
      // recomputes for this row — `prev_hash` is itself a digest input — so the
      // row's own `hash` is recomputed too, keeping it internally
      // self-consistent while genuinely disconnected from its true
      // predecessor. That is what "unlinked" means: not a corrupted row, a
      // row lying about what came before it.
      await db().raw('ALTER TABLE activity_log DISABLE TRIGGER activity_log_no_update');
      await db().raw(
        `UPDATE activity_log
            SET prev_hash = ?,
                hash = activity_log_row_hash(?, sequence, entity_type, entity_id, action, actor_type, actor_id, details)
          WHERE id = ?`,
        ['f'.repeat(64), 'f'.repeat(64), row.id],
      );
      await db().raw('ALTER TABLE activity_log ENABLE TRIGGER activity_log_no_update');

      const result = await logService.verifyLogChain({}, actor);
      expect(result.ok).toBe(false);
      expect(result.firstBreak?.kind).toBe('prev_hash_mismatch');
    });

    it('LOG-11: counts pre-chain rows as unverifiable, not broken', async () => {
      // The chain trigger recomputes `sequence`/`prev_hash`/`hash` on every
      // INSERT regardless of what the statement supplies, so a genuine
      // pre-chain row (one predating the chain entirely) can only be
      // fabricated in a test the same way the tamper tests fabricate a
      // broken one: with the trigger held off for the one statement.
      await db().raw('ALTER TABLE activity_log DISABLE TRIGGER activity_log_chain_trg');
      await db()('activity_log').insert({
        tenant_id: actor.tenantId,
        entity_type: 'legacy',
        entity_id: 'x',
        action: 'created',
        actor_type: 'system',
        actor_id: null,
        details: null,
        sequence: 999999,
        prev_hash: '0'.repeat(64),
        hash: 'pre-chain',
      });
      await db().raw('ALTER TABLE activity_log ENABLE TRIGGER activity_log_chain_trg');

      const result = await logService.verifyLogChain({ fromSequence: '999999', toSequence: '999999' }, actor);
      expect(result.ok).toBe(true);
      expect(result.checkedCount).toBe(0);
      expect(result.skippedPreChainCount).toBe(1);
    });

    it('LOG-12: verification runs in SQL — a row with unicode and key-ordering JSON still verifies', async () => {
      await fieldsService.createValue(
        { listKey: 'stock.colour', value: 'नीला', label: 'नीला (Blue)' },
        actor,
      );
      const result = await logService.verifyLogChain({}, actor);
      expect(result.ok).toBe(true);
    });

    it('LOG-13: verifying writes exactly one audit entry, after the scan; listing writes none', async () => {
      await catalogService.createParty({ name: 'Audit Count Party' }, actor);

      const before = await db()('activity_log').where({ tenant_id: actor.tenantId }).count<{ count: string }[]>('id as count');
      await logService.listLogs({}, actor);
      const afterList = await db()('activity_log').where({ tenant_id: actor.tenantId }).count<{ count: string }[]>('id as count');
      expect(afterList[0]!.count).toBe(before[0]!.count);

      await logService.verifyLogChain({}, actor);
      const afterVerify = await db()('activity_log').where({ tenant_id: actor.tenantId }).count<{ count: string }[]>('id as count');
      expect(Number(afterVerify[0]!.count)).toBe(Number(before[0]!.count) + 1);

      const verifyRow = await db()('activity_log')
        .where({ tenant_id: actor.tenantId, action: 'verified' })
        .orderBy('id', 'desc')
        .first('entity_type');
      expect(verifyRow.entity_type).toBe('activity_log');
    });

    it('refuses without logs.verifyChain even when logs.view is held', async () => {
      const viewOnly = await actorWith(['logs.view']);
      await expect(logService.verifyLogChain({}, viewOnly)).rejects.toMatchObject({
        code: 'forbidden',
        details: { permission: 'logs.verifyChain' },
      });
    });
  });

  describe('export', () => {
    it('LOG-14 (export half): refused without logs.export', async () => {
      const viewOnly = await actorWith(['logs.view']);
      await expect(logService.exportLogs({}, viewOnly)).rejects.toMatchObject({
        code: 'forbidden',
        details: { permission: 'logs.export' },
      });
    });

    it('produces a CSV with a header row and one row per entry, and records the export', async () => {
      await catalogService.createParty({ name: 'Export Party' }, actor);
      const { csv, rowCount } = await logService.exportLogs({ entityType: 'party' }, actor);

      expect(rowCount).toBeGreaterThan(0);
      const lines = csv.trim().split('\r\n');
      expect(lines[0]).toBe('id,sequence,createdAt,actorType,actorName,entityType,entityId,action,hash');
      expect(lines).toHaveLength(rowCount + 1);

      const exportRow = await db()('activity_log')
        .where({ tenant_id: actor.tenantId, action: 'exported' })
        .first('entity_type');
      expect(exportRow.entity_type).toBe('activity_log');
    });
  });
});
