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

import { activityMessageKey, EN_MESSAGES } from '@orderbook/shared';

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
  /** The keys of the `details` object literal, if the call site has one. */
  detailKeys: string[];
  /**
   * True when `details` is a variable built earlier rather than an inline
   * literal (`user.service.ts` accumulates a diff across a dozen branches).
   * Reading source cannot tell what that variable holds, so those call sites
   * are exempt from the placeholder check below — and this field exists so the
   * exemption is a stated blind spot rather than a silent pass.
   */
  detailsIsVariable: boolean;
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
    const window = block.slice(0, 1200);
    const entityMatch = /entityType:\s*'([^']+)'/.exec(window);
    const actionMatch = /action:\s*'([^']+)'/.exec(window);
    // `action` computed from a ternary (`user.service.ts`'s deactivated/updated
    // branch) is handled as a special case below rather than by this regex.
    if (entityMatch && actionMatch) {
      pairs.push({
        file,
        entityType: entityMatch[1] as string,
        action: actionMatch[1] as string,
        detailKeys: detailKeysIn(window),
        detailsIsVariable: /details,/.test(window),
      });
    }
  }

  return pairs;
}

/**
 * The keys a call site's `details` expression sets.
 *
 * Everything from `details:` to the end of the window, with every `key:` in it
 * collected. Deliberately crude in the **lenient** direction: a ternary
 * (`details: secret ? { name: key } : { name: key, value }`), a spread and a
 * nested object all read as "these names are supplied". A first attempt matched
 * only a flat `details: { … }` literal and called four honest call sites
 * defective, which is the failure mode worth avoiding — a check that cries wolf
 * gets switched off.
 */
function detailKeysIn(window: string): string[] {
  const at = window.indexOf('details:');
  if (at === -1) return [];

  // Every identifier, not just those followed by a colon: `details: { name,
  // tier }` is shorthand, and demanding `name:` called `role.created` defective
  // when it supplies the name perfectly well.
  return [...window.slice(at).matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)].map((match) => match[0]);
}

/** `{actor} added the party {name}` -> ['actor', 'name']. */
function placeholdersIn(template: string): string[] {
  return [...template.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((match) => match[1] as string);
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

  /*
   * Having a token is not enough: it has to be fillable.
   *
   * Found by looking at a running Activity log, which showed "Karan via API key
   * updated the product {name}" — the token existed, the call site passed no
   * `details`, and the placeholder reached the screen verbatim. A row written
   * that way can never be corrected, because `activity_log` refuses UPDATE.
   *
   * `{actor}` is supplied by the renderer from `actor_name`, so it is never a
   * call site's job.
   */
  it.each(
    [
      ...new Map(allPairs.map((pair) => [`${pair.entityType}.${pair.action}`, pair])).values(),
    ].filter(
      (pair) =>
        activityMessageKey(pair.entityType, pair.action) !== null && !pair.detailsIsVariable,
    ),
  )('$file: activity.$entityType.$action supplies every placeholder it renders', (pair) => {
    const key = activityMessageKey(pair.entityType, pair.action);
    const template = (EN_MESSAGES as Record<string, string>)[key as string] ?? '';

    const needed = placeholdersIn(template).filter((name) => name !== 'actor');
    const missing = needed.filter((name) => !pair.detailKeys.includes(name));

    expect(missing, `${key} renders ${missing.join(', ')} with nothing to fill it`).toEqual([]);
  });
});
