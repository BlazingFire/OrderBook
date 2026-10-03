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
  ROLE_TIERS,
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

describe('neither catalogue talks about prices', () => {
  // The software carries no money at all — pricing was removed on 2026-09-21 —
  // so a word for a price on screen points at a feature that does not exist.
  // The Products settings group went on reading "Stock and prices" (`स्टॉक और दाम`)
  // after the last price had gone.
  //
  // Both patterns run over both catalogues, because an untranslated Hindi
  // entry is English text. The Hindi one is bounded by letters and marks
  // rather than `\b`, which knows only ASCII: `दाम` is price, and it is also
  // the tail of `गोदाम`, a warehouse. Each Hindi word is a stem that may carry
  // vowel signs and nasalisation after it, which is how Hindi inflects —
  // `दामों`, `कीमतें`, `रुपयों`, `पैसा` — but no further letter, so `रेटिंग`
  // (rating) and `मूल्यांकन` (evaluation) pass. A plural that adds a letter,
  // `राशियाँ`, is a stem of its own. `मूल्य` also means "value", but this
  // catalogue's word for a value is `मान` (`validation.fields.valueRequired`),
  // so here it can only be a price.
  const ENGLISH = /\b(prices?|priced|pricing|rates?|amounts?|discounts?|rupees?|paise)\b/i;
  const HINDI_STEMS = [
    'दाम',
    'कीमत',
    'क\u093Cीमत', // क + nukta, and the precomposed letter below
    '\u0958ीमत',
    'मूल्य',
    'रुपय',
    'रुपए',
    'पैस',
    'राशि',
    'राशिय',
    'रेट',
  ];
  const HINDI = new RegExp(
    `(?<![\\p{L}\\p{M}])(${HINDI_STEMS.join('|')})\\p{M}*(?![\\p{L}\\p{M}])`,
    'u',
  );
  const talksAboutPrice = (value: string): boolean => ENGLISH.test(value) || HINDI.test(value);

  it.each([
    ['en', EN_MESSAGES],
    ['hi', HI_MESSAGES],
  ] as const)('%s', (_locale, catalogue) => {
    const offenders = Object.entries(catalogue as Record<string, string>)
      .filter(([, value]) => talksAboutPrice(value))
      .map(([key]) => key);

    expect(offenders).toEqual([]);
  });

  // The words above as a translator writes them, plural and oblique included,
  // with `क़ीमत` spelt both ways.
  it.each([
    'दामों की सूची',
    'कीमतें',
    'कीमतों में',
    'क\u093Cीमतों',
    '\u0958ीमत',
    'रुपयों',
    'मूल्यों',
    'पैसा',
    'पैसों',
    'राशियाँ',
    'रेटों',
  ])('catches %s', (phrase) => {
    expect(talksAboutPrice(phrase)).toBe(true);
  });

  it.each(['{onFloor} गोदाम में', 'गोदामों', 'रेटिंग', 'मूल्यांकन', 'पैसेंजर', 'separate'])(
    'leaves %s alone',
    (phrase) => {
      expect(talksAboutPrice(phrase)).toBe(false);
    },
  );
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

describe('every Hindi activity.* sentence can take the unknown actor', () => {
  // `renderActivity` fills `{actor}` with `logs.actor.unknown` when a row
  // recorded no name, and in Hindi that is `किसी` — the oblique form, which is
  // only a sentence with a postposition after it (`किसी ने …`). There is one
  // stand-in for every template, so every template has to be built that way.
  // An English stub is not: it rendered "किसी issued the API key …". That
  // includes the stub `npm run i18n:sync` writes for a new activity key — it
  // fails here until somebody translates it.
  const POSTPOSITION = /^ (ने|को|से|का|की|के|में|पर|द्वारा)(?![\p{L}\p{M}])/u;

  it('puts a postposition after every {actor}, in activity.* and activityDetail.* alike', () => {
    const offenders = Object.entries(HI_MESSAGES as Record<string, string>)
      .filter(([key]) => key.startsWith('activity.') || key.startsWith('activityDetail.'))
      .filter(([, value]) =>
        value
          .split('{actor}')
          .slice(1)
          .some((rest) => !POSTPOSITION.test(rest)),
      )
      .map(([key]) => key);

    expect(offenders).toEqual([]);
  });
});

describe('the Logs screen can name everything the trail records', () => {
  const pairs = [...ACTIVITY_TOKENS].map((pair) => pair.split('.') as [string, string]);

  it('has a logs.entity.<type> label for every record type with an activity token', () => {
    const missing = [...new Set(pairs.map(([entity]) => `logs.entity.${entity}`))].filter((key) => !EN_KEYS.has(key));
    expect(missing).toEqual([]);
  });

  it('has a logs.action.<action> label for every action with an activity token', () => {
    const missing = [...new Set(pairs.map(([, action]) => `logs.action.${action}`))].filter((key) => !EN_KEYS.has(key));
    expect(missing).toEqual([]);
  });

  it('has an activityDetail.* sentence only for a pair that also has its plain activity.* sentence', () => {
    // The richer sentence is a fallback chain, never the only sentence: a row
    // missing a detail field renders the plain one.
    const orphaned = [...EN_KEYS]
      .filter((key) => key.startsWith('activityDetail.'))
      .filter((key) => !ACTIVITY_TOKENS.has(key.slice('activityDetail.'.length)));
    expect(orphaned).toEqual([]);
  });

  it('labels every role tier', () => {
    for (const tier of ROLE_TIERS) expect(EN_KEYS.has(`tier.${tier}`), tier).toBe(true);
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
