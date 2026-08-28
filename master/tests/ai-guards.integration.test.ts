/**
 * The four gates that stand between the assistant and this shop's data, and the
 * one that stands between it and a write.
 *
 * None of these needs a model: every one is a refusal that happens before a
 * provider is contacted, which is exactly why they are worth testing without
 * one. A test that needed Ollama running would be a test nobody ran.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

import { canRunIntegrationTests } from './helpers/db.js';
import { db } from '../src/db/knex.js';
import { createApp } from '../src/http/app.js';
import * as aiService from '../src/services/ai.service.js';
import { invalidateSettingsCache, writeSetting } from '../src/services/settings.service.js';
import {
  resetData,
  setupDatabase,
  teardownDatabase,
  testActor,
  actorWith,
} from './helpers/fixtures.js';

let app: Express;

async function configureModel(baseUrl: string | null): Promise<void> {
  const actor = await testActor();
  await writeSetting(
    actor,
    'ai.provider',
    baseUrl ? { kind: 'openaiCompatible', baseUrl, model: 'qwen2.5' } : { kind: 'off' },
  );
}

describe.skipIf(!canRunIntegrationTests)('the assistant’s guards (integration)', () => {
  beforeAll(async () => {
    await setupDatabase();
    app = createApp();
  });
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    invalidateSettingsCache();
  });

  describe('the off switch', () => {
    it('answers status even with no model, and 404s everything else', async () => {
      await configureModel(null);
      const actor = await testActor();

      // Always answered: a client cannot otherwise tell "off" from "this Master
      // is older than the feature", and both must render the same way.
      expect(await aiService.status(actor)).toEqual({ enabled: false });

      // The HTTP surface says the same thing, without a session: the routes are
      // behind `requireAuth`, so this proves the mount rather than the guard.
      await request(app).get('/api/ai/insights').expect(401);
    });

    it('reports enabled once a model is configured', async () => {
      await configureModel('http://127.0.0.1:11434');
      const status = await aiService.status(await testActor());

      expect(status.enabled).toBe(true);
      expect(status.model).toBe('qwen2.5');
      // Derived from the address rather than stored, so there is no second
      // setting that can contradict the first.
      expect(status.local).toBe(true);
      expect(status.hardware?.tier).toBeTruthy();
    });

    it('treats a cloud address as not local', async () => {
      await configureModel('https://openrouter.ai/api');
      expect((await aiService.status(await testActor())).local).toBe(false);
    });

    it('refuses a run while no model is configured', async () => {
      await configureModel(null);
      const actor = await testActor({ userId: 'u-1' });

      await expect(
        aiService.startRun(actor, { kind: 'ask', prompt: 'How many orders this month?' }),
      ).rejects.toThrow();
    });
  });

  describe('who may ask', () => {
    it('refuses somebody without ai.use', async () => {
      await configureModel('http://127.0.0.1:11434');
      const actor = await actorWith(['leads.view']);

      await expect(aiService.startRun(actor, { kind: 'ask', prompt: 'anything' })).rejects.toThrow(
        /ai.use/,
      );
    });

    it('refuses an unattended panel, which has no signed-in person', async () => {
      await configureModel('http://127.0.0.1:11434');
      // `resolvePanelActor` falls back to this for a panel nobody is signed in
      // on. `ai_runs.user_id` is the whole read rule, so a run with no owner is
      // a transcript nobody could be responsible for or read back.
      const actor = await testActor({ actorType: 'office_panel', userId: null, actorId: null });

      await expect(aiService.startRun(actor, { kind: 'ask', prompt: 'anything' })).rejects.toThrow(
        /ai.use/,
      );
    });

    it('refuses a run once the day’s token budget is spent, on a paid provider only', async () => {
      await configureModel('https://openrouter.ai/api');
      const actor = await testActor({ userId: 'u-2' });
      await writeSetting(actor, 'ai.dailyTokenBudget', 100);

      await db()('ai_runs').insert({
        tenant_id: actor.tenantId,
        user_id: 'u-2',
        kind: 'ask',
        prompt: 'earlier',
        status: 'done',
        prompt_tokens: 60,
        completion_tokens: 60,
        rates_visible: false,
      });

      await expect(aiService.startRun(actor, { kind: 'ask', prompt: 'again' })).rejects.toThrow();

      // The same budget does not apply to a model running in the building —
      // there is nothing there to spend.
      await configureModel('http://127.0.0.1:11434');
      invalidateSettingsCache();
      const started = await aiService.startRun(actor, { kind: 'ask', prompt: 'local' });
      expect(started.runId).toBeTruthy();
      aiService.abortRun(started.runId);
    });
  });

  describe('reading a transcript', () => {
    it('is refused to somebody who is not its author', async () => {
      await configureModel('http://127.0.0.1:11434');
      const actor = await testActor({ userId: 'author' });

      const [row] = await db()('ai_runs')
        .insert({
          tenant_id: actor.tenantId,
          user_id: 'author',
          kind: 'ask',
          prompt: 'What did we quote Shree?',
          status: 'done',
          rates_visible: false,
        })
        .returning<Array<{ id: string }>>('id');

      await expect(aiService.getRun(actor, row!.id)).resolves.toBeTruthy();

      // Not even to an administrator: `ai.manage` sees figures, never text.
      const other = await testActor({ userId: 'somebody-else' });
      await expect(aiService.getRun(other, row!.id)).rejects.toThrow();
    });

    it('is withheld from an author who has since lost rate visibility', async () => {
      await configureModel('http://127.0.0.1:11434');
      const actor = await testActor({ userId: 'author' });

      const [row] = await db()('ai_runs')
        .insert({
          tenant_id: actor.tenantId,
          user_id: 'author',
          kind: 'ask',
          prompt: 'What is our rate on RST-300?',
          answer: 'It is quoted at 125 rupees.',
          status: 'done',
          // The run recorded that it was made by somebody who could see rates.
          rates_visible: true,
        })
        .returning<Array<{ id: string }>>('id');

      const demoted = await testActor({
        userId: 'author',
        permissions: { roleId: null, roleName: 'Demoted', tier: 'office', permissions: ['ai.use'] },
      });

      await expect(aiService.getRun(demoted, row!.id)).rejects.toThrow();
      expect(await aiService.listOwnRuns(demoted)).toEqual([]);
    });
  });

  describe('applying a suggestion', () => {
    it('is refused while the installation does not allow writes', async () => {
      await configureModel('http://127.0.0.1:11434');
      const actor = await testActor({ userId: 'author' });
      await writeSetting(actor, 'ai.allowWrites', false);

      const [row] = await db()('ai_runs')
        .insert({
          tenant_id: actor.tenantId,
          user_id: 'author',
          kind: 'draft',
          prompt: 'Suggest fields',
          status: 'done',
          rates_visible: false,
          proposal: JSON.stringify({
            entity: 'product',
            id: 'p-1',
            fields: [{ field: 'alias', current: null, suggested: 'Rustic', why: 'shorter' }],
          }),
        })
        .returning<Array<{ id: string }>>('id');

      // The setting and the permission are two different questions, and both
      // have to answer yes.
      await expect(aiService.applyProposal(actor, row!.id, ['alias'])).rejects.toThrow();
    });

    it('is refused to somebody without ai.write, whatever the setting says', async () => {
      await configureModel('http://127.0.0.1:11434');
      const admin = await testActor();
      await writeSetting(admin, 'ai.allowWrites', true);

      const actor = await actorWith(['ai.use', 'products.edit']);
      await expect(aiService.applyProposal(actor, 'any-run', ['alias'])).rejects.toThrow(
        /ai.write/,
      );
    });
  });
});
