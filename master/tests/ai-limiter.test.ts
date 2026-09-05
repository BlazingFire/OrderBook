/**
 * The AI run limiter must not leak a slot, and must not leave a row behind.
 *
 * `activeRunCount` is module-level and process-global. The only decrement is in
 * the `.finally()` attached to `generate(...)`, so anything that throws between
 * the acquire and that attachment leaks a slot permanently — and
 * `ai.maxConcurrentRuns` defaults to 2, so two leaks disable the assistant for
 * the whole installation until the Master is restarted, with no diagnostic.
 *
 * There are two ways to get this wrong and they sit on opposite sides of one
 * line, which is why all three cases below exist:
 *
 *   - Acquire too early (`d52bdef`): an ordinary `validation.ai.budgetSpent`
 *     refusal — the designed answer to a user exceeding the daily budget —
 *     leaks a slot.
 *   - Acquire too late (after `insertRun`): an ordinary
 *     `error.ai.tooManyConcurrent` or `error.ai.memoryPressure` refusal leaves a
 *     committed `ai_runs` row at `status='running'` that is in neither the
 *     `running` nor the `ownerOf` map, so nothing can abort or finish it and
 *     only `failStaleAiRuns` at the next boot ever touches it.
 *
 * ## Why the assertions name the error
 *
 * The first version of this file asserted `rejects.toThrow()` with no argument,
 * twice, with `ai.maxConcurrentRuns` stubbed to 3. A leaked slot produces
 * `error.ai.tooManyConcurrent`, which satisfies a bare `toThrow()` exactly as
 * well as `validation.ai.budgetSpent` does — so it passed against the leaking
 * code. That was checked rather than assumed: restoring the pre-fix ordering
 * and re-running it gave `1 passed`.
 *
 * No database and no model: the repository and settings are stubbed, so this
 * runs inside `npm run verify` rather than behind the PostgreSQL skip that hid
 * the original bug.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the database and settings before importing the service.
vi.mock('../src/db/knex.js', () => ({
  db: () => {
    throw new Error('should not reach database');
  },
}));

vi.mock('../src/services/settings.service.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getSetting: vi.fn(),
  };
});

vi.mock('../src/repositories/ai-run.repository.js', () => ({
  tokensSpentToday: vi.fn(),
  insertRun: vi.fn(),
  findRunOwnership: vi.fn(),
  findRun: vi.fn(),
  listOwnRuns: vi.fn(),
  purgeOlderThan: vi.fn(),
  failStaleRuns: vi.fn(),
}));

/** Mutable, so one case can put the process over its RAM cap. */
const memoryStatus = {
  isOverCap: false,
  rssMb: 100,
  capMb: 512,
};

vi.mock('../src/lib/memory-monitor.js', () => ({
  getMemoryStatus: () => memoryStatus,
}));

import type { ActorContext } from '../src/domain/actor.js';
import * as aiService from '../src/services/ai.service.js';
import { getSetting } from '../src/services/settings.service.js';
import { insertRun, tokensSpentToday } from '../src/repositories/ai-run.repository.js';

const mockGetSetting = vi.mocked(getSetting);
const mockTokensSpentToday = vi.mocked(tokensSpentToday);
const mockInsertRun = vi.mocked(insertRun);

function makeActor(userId = 'u-1'): ActorContext {
  return {
    tenantId: 't-1',
    actorType: 'user',
    actorId: userId,
    userId,
    permissions: { roleId: null, roleName: 'Test', tier: 'admin', permissions: ['ai.use'] },
    deviceCode: null,
    actorName: 'Test Actor',
  };
}

/** A remote provider with a daily budget — the shape every case here needs. */
function settings(budget: number, maxConcurrent: number): void {
  mockGetSetting.mockImplementation(async (_tenantId: string, key: string) => {
    if (key === 'ai.provider')
      return {
        kind: 'openaiCompatible' as const,
        baseUrl: 'https://openrouter.ai/api',
        model: 'qwen',
      };
    if (key === 'ai.apiKey') return 'sk-test';
    if (key === 'ai.dailyTokenBudget') return budget;
    if (key === 'ai.maxConcurrentRuns') return maxConcurrent;
    return false;
  });
}

const ask = { kind: 'ask' as const, prompt: 'test' };

describe('AI run limiter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    memoryStatus.isOverCap = false;
  });

  it('does not leak a slot when the daily budget refuses the run', async () => {
    // maxConcurrent is 1, so a single leaked slot changes the second call's
    // answer. At the shipped default of 2 it would take two refusals.
    settings(100, 1);
    mockTokensSpentToday.mockResolvedValue(100);

    const actor = makeActor();
    const budgetSpent = { messageKey: 'validation.ai.budgetSpent' };

    await expect(aiService.startRun(actor, ask)).rejects.toMatchObject(budgetSpent);

    // Pre-fix this second call answered `error.ai.tooManyConcurrent`: the first
    // refusal had already taken the only slot and nothing gave it back.
    await expect(aiService.startRun(actor, ask)).rejects.toMatchObject(budgetSpent);
  });

  it('does not leak a slot when writing the run row fails', async () => {
    // `insertRun` is the one call that can still throw between the acquire and
    // the point `generate`'s own `.finally()` takes ownership of the slot.
    settings(0, 1);

    const actor = makeActor();

    mockInsertRun.mockRejectedValueOnce(new Error('database is down'));
    await expect(aiService.startRun(actor, ask)).rejects.toThrow('database is down');

    // The slot must have come back. Without the release on that path this
    // second call is refused for concurrency instead of failing on the insert.
    mockInsertRun.mockRejectedValueOnce(new Error('database is down'));
    await expect(aiService.startRun(actor, ask)).rejects.toThrow('database is down');
  });

  it('writes no run row when the run is refused', async () => {
    // The mirror bug. Acquiring the slot *after* `insertRun` moves the leak
    // from the counter into the table: the refusal is ordinary, but the row is
    // already committed at status='running' and nothing can ever finish it.
    settings(0, 1);
    memoryStatus.isOverCap = true;

    const actor = makeActor();
    await expect(aiService.startRun(actor, ask)).rejects.toMatchObject({
      messageKey: 'error.ai.memoryPressure',
    });

    expect(mockInsertRun).not.toHaveBeenCalled();
  });
});
