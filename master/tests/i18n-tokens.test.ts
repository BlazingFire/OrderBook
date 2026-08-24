/**
 * Source-reading invariant, in the `credential-invariants.test.ts` style:
 * every literal `(entityType, action)` pair passed to `recordActivity` or
 * `recordDetachedActivity` across `master/src/services` has a catalogue
 * token. This is what stops a new audited action shipping permanently
 * untranslated — a row written today can never be corrected, because
 * `activity_log` refuses UPDATE and DELETE by trigger.
 *
 * Deliberately reads source rather than exercising the services: a call site
 * can build its `entityType`/`action` from two adjacent string literals
 * without ever running, and this test's job is to catch that before the
 * first real row is written, not after.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { activityMessageKey } from '@orderbook/shared';

const SERVICES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'services',
);

interface Pair {
  file: string;
  entityType: string;
  action: string;
}

/**
 * Finds every `entityType: '<x>', ... action: '<y>'` (or the reverse order)
 * pair inside an object literal passed to `recordActivity`/
 * `recordDetachedActivity`. Deliberately tolerant of a few intervening lines
 * (actorType, actorId, comments) between the two fields, matching how these
 * call sites are actually formatted.
 */
function extractPairs(file: string, source: string): Pair[] {
  const pairs: Pair[] = [];
  const callSites = source.split(/recordDetachedActivity\(|recordActivity\(/).slice(1);

  for (const block of callSites) {
    // Only look inside the first object literal of the call — up to the
    // first line that starts a new top-level statement is overkill; taking a
    // generous slice and matching within it is enough for this file's
    // deliberately uniform call shape.
    const window = block.slice(0, 400);
    const entityMatch = /entityType:\s*'([^']+)'/.exec(window);
    const actionMatch = /action:\s*'([^']+)'/.exec(window);
    // `action` computed from a ternary (`user.service.ts`'s deactivated/updated
    // branch) is handled as a special case below rather than by this regex.
    if (entityMatch && actionMatch) {
      pairs.push({ file, entityType: entityMatch[1] as string, action: actionMatch[1] as string });
    }
  }

  return pairs;
}

function allServiceFiles(): string[] {
  return readdirSync(SERVICES_DIR)
    .filter((file) => file.endsWith('.service.ts'))
    .map((file) => path.join(SERVICES_DIR, file));
}

describe('every recordActivity call site has a catalogue token', () => {
  const allPairs = allServiceFiles().flatMap((file) =>
    extractPairs(path.basename(file), readFileSync(file, 'utf8')),
  );

  it('found at least the known call sites — a guard against the extractor itself silently matching nothing', () => {
    expect(allPairs.length).toBeGreaterThanOrEqual(20);
  });

  it.each(
    // De-duplicated: the same pair recorded at several call sites is one
    // token requirement, not several test cases.
    [...new Map(allPairs.map((pair) => [`${pair.entityType}.${pair.action}`, pair])).values()],
  )('$file: activity.$entityType.$action has a catalogue entry', ({ entityType, action }) => {
    expect(activityMessageKey(entityType, action)).not.toBeNull();
  });

  it("covers user.service.ts's conditional deactivated/updated action explicitly", () => {
    // `action: input.isActive === false ? 'deactivated' : 'updated'` is a
    // ternary, not a literal, so the regex extractor above cannot see it —
    // both branches are asserted here by hand instead.
    expect(activityMessageKey('user', 'deactivated')).not.toBeNull();
    expect(activityMessageKey('user', 'updated')).not.toBeNull();
  });

  it("covers auth.service.ts's conditional sign_in/sign_in_failed action explicitly", () => {
    // `action: success ? 'sign_in' : 'sign_in_failed'` — same shape, same reason.
    expect(activityMessageKey('user', 'sign_in')).not.toBeNull();
    expect(activityMessageKey('user', 'sign_in_failed')).not.toBeNull();
  });
});
