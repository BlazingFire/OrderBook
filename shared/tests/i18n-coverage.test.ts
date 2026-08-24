/**
 * The catalogue-CONTRACT suite — not the renderer (`i18n.test.ts` owns that).
 * This is what makes the `labelToken` contract on `permissions.ts` load-bearing
 * rather than decorative: every key it promises a token for actually has one,
 * and Hindi actually covers what English defines.
 *
 * Pure. No `describe.skipIf` anywhere in this file.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  ACTIONS,
  ACTIVITY_TOKENS,
  CAPABILITIES,
  CAPABILITY_GROUPS,
  EN_MESSAGES,
  HI_MESSAGES,
  MODULES,
  MODULE_ACTIONS,
  PERMISSIONS,
  ROLE_TEMPLATES,
  actionLabelToken,
  isPermission,
  moduleActionLabelToken,
} from '../src/index.js';

const EN_KEYS = new Set(Object.keys(EN_MESSAGES));
const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));

function placeholders(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string).sort();
}

describe('the EN catalogue is complete over the permission surface', () => {
  it('has a permission.<key> token for every capability', () => {
    for (const capability of CAPABILITIES) {
      expect(EN_KEYS.has(`permission.${capability.key}`)).toBe(true);
    }
  });

  it('has a permission.<module>.<action> token for every module action key', () => {
    for (const module of MODULES) {
      for (const action of MODULE_ACTIONS[module]) {
        expect(EN_KEYS.has(moduleActionLabelToken(module, action))).toBe(true);
      }
    }
  });

  it('has a module.<key> token for every module', () => {
    for (const module of MODULES) expect(EN_KEYS.has(`module.${module}`)).toBe(true);
  });

  it('has an action.<key> token for every action', () => {
    for (const action of ACTIONS) expect(EN_KEYS.has(actionLabelToken(action))).toBe(true);
  });

  it('has a capabilityGroup.<key> token for every capability group', () => {
    for (const group of CAPABILITY_GROUPS) expect(EN_KEYS.has(`capabilityGroup.${group}`)).toBe(true);
  });

  it('has a roleTemplate token for every role template', () => {
    for (const template of ROLE_TEMPLATES) expect(EN_KEYS.has(template.nameToken)).toBe(true);
  });

  it('every key referenced by the permission catalogue is a real, known permission', () => {
    for (const capability of CAPABILITIES) expect(isPermission(capability.key)).toBe(true);
    expect(PERMISSIONS.length).toBeGreaterThan(0);
  });
});

describe('hi.ts is total and placeholder-identical to en.ts', () => {
  it('has no key missing relative to en.ts', () => {
    const missing = Object.keys(EN_MESSAGES).filter((key) => !(key in HI_MESSAGES));
    expect(missing).toEqual([]);
  });

  it('has no key extra relative to en.ts', () => {
    const extra = Object.keys(HI_MESSAGES).filter((key) => !(key in EN_MESSAGES));
    expect(extra).toEqual([]);
  });

  it('carries an identical placeholder set per key — the case the compiler cannot catch', () => {
    const mismatched: string[] = [];

    for (const key of Object.keys(EN_MESSAGES)) {
      const enPlaceholders = placeholders((EN_MESSAGES as Record<string, string>)[key] ?? '');
      const hiPlaceholders = placeholders((HI_MESSAGES as Record<string, string>)[key] ?? '');
      if (JSON.stringify(enPlaceholders) !== JSON.stringify(hiPlaceholders)) mismatched.push(key);
    }

    expect(mismatched).toEqual([]);
  });
});

describe('no EN string carries a pre-formatted number, separator or currency symbol', () => {
  it('contains no digit sequence of three or more (a thousands-separated or raw number)', () => {
    const offenders = Object.entries(EN_MESSAGES)
      .filter(([, value]) => /\d{3,}/.test(value))
      .map(([key]) => key);

    expect(offenders).toEqual([]);
  });

  it('contains no rupee sign', () => {
    const offenders = Object.entries(EN_MESSAGES)
      .filter(([, value]) => value.includes('₹'))
      .map(([key]) => key);

    expect(offenders).toEqual([]);
  });
});

describe('the activity.* surface is append-only', () => {
  // Read, never imported — a JSON import would go through `tsc`'s module
  // resolution and could be quietly re-shaped; `readFileSync` reads exactly
  // the bytes committed.
  const lockedPairs = JSON.parse(
    readFileSync(path.join(TESTS_DIR, 'activity-tokens.lock.json'), 'utf8'),
  ) as string[];

  it('has not lost a single previously-committed activity token', () => {
    const missing = lockedPairs.filter((token) => !ACTIVITY_TOKENS.has(token.slice('activity.'.length)));
    expect(missing).toEqual([]);
  });

  it('the lockfile itself has no entry that is not also a real EN token', () => {
    const orphaned = lockedPairs.filter((token) => !EN_KEYS.has(token));
    expect(orphaned).toEqual([]);
  });
});

describe('count.* stems have both .one and .other siblings', () => {
  it('every .other has a matching .one', () => {
    const stems = Object.keys(EN_MESSAGES)
      .filter((key) => key.endsWith('.other'))
      .map((key) => key.slice(0, -'.other'.length));

    for (const stem of stems) expect(EN_KEYS.has(`${stem}.one`)).toBe(true);
  });
});
