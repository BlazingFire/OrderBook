/**
 * The settings declaration table's own contract.
 *
 * Pure — no database, no server. Two things are checked, and both are the kind
 * that only bite in production: a key whose label the Settings screen cannot
 * render, and a parser that rejects the very default it ships with (which would
 * make `getSetting` log a warning and fall back on every single read).
 */

import { describe, expect, it } from 'vitest';

import {
  EN_MESSAGES,
  HI_MESSAGES,
  SETTINGS,
  SETTING_GROUPS,
  SETTING_KEYS,
  isSecretSetting,
  isSettingKey,
  type SettingControl,
} from '../src/index.js';

describe('every setting is renderable in both languages', () => {
  it.each(SETTING_KEYS)('%s has an EN and HI label and help token', (key) => {
    const { labelToken, descriptionToken } = SETTINGS[key];

    for (const token of [labelToken, descriptionToken]) {
      expect(Object.keys(EN_MESSAGES)).toContain(token);
      expect(Object.keys(HI_MESSAGES)).toContain(token);
    }
  });
});

describe('every parser accepts its own default', () => {
  it.each(SETTING_KEYS)('%s round-trips its fallback', (key) => {
    const definition = SETTINGS[key];
    expect(() => definition.parse(definition.fallback)).not.toThrow();
    expect(definition.parse(definition.fallback)).toEqual(definition.fallback);
  });
});

describe('every parser rejects a wrong shape', () => {
  // One deliberately wrong value per key — not `undefined`, which several
  // parsers would reject for the uninteresting reason that it is not an object.
  const WRONG: Record<string, unknown> = {
    'security.passwordRevealEnabled': 'yes',
    'pricing.enabled': 'yes',
    'inventory.freeToSell': 'yes',
    'externalApi.enabled': 1,
    'panels.autoPairingEnabled': 'yes',
    'security.developerModeEnabled': 'yes',
    'catalog.importCreatesCategories': 'yes',
    // Below their floors rather than the wrong type: for a bounded number the
    // interesting refusal is the in-range-looking value that is out of range —
    // 0 hours signs the administrator out on their next request, and 0 quiet
    // days calls every lead quiet on the day it is raised.
    'security.sessionHours': 0,
    'leads.quietAfterDays': 0,
    'inventory.defaultReorderLevel': -1,
  };

  it.each(SETTING_KEYS)('%s throws on a value it cannot mean', (key) => {
    expect(Object.keys(WRONG)).toContain(key);
    expect(() => SETTINGS[key].parse(WRONG[key])).toThrow();
  });
});

describe('every setting declares a control its fallback fits', () => {
  // The Settings screen renders from the declared `control`, not from
  // `typeof value` — which is what removed the old dead branch that printed
  // JSON beside the words "edited elsewhere". That only holds while the two
  // agree, and nothing in the type system makes them: `satisfies` checks the
  // shape of each field independently. So it is checked here, and a future
  // `'documents.paperSize': 'A4'` fails this suite until its control ships
  // with it.
  it.each(SETTING_KEYS)('%s', (key) => {
    const definition = SETTINGS[key];
    if (isSecretSetting(key)) return; // a secret's control is never read

    // Read through the declared union, not the literal type each entry
    // infers: `nullable` is optional, so on an entry that omits it the narrow
    // type has no such property at all and the check below will not compile.
    const control: SettingControl = definition.control;
    const { fallback } = definition;

    if (control.kind === 'boolean') {
      expect(typeof fallback).toBe('boolean');
      return;
    }

    expect(control.kind).toBe('number');
    if (control.nullable && fallback === null) return;
    expect(typeof fallback).toBe('number');
    expect(fallback as number).toBeGreaterThanOrEqual(control.min);
    expect(fallback as number).toBeLessThanOrEqual(control.max);
  });
});

describe('every setting belongs to a declared group', () => {
  it.each(SETTING_KEYS)('%s', (key) => {
    expect(SETTING_GROUPS).toContain(SETTINGS[key].group);
  });

  it('every group has a heading in both catalogues', () => {
    for (const group of SETTING_GROUPS) {
      expect(Object.keys(EN_MESSAGES)).toContain(`settingGroup.${group}`);
      expect(Object.keys(HI_MESSAGES)).toContain(`settingGroup.${group}`);
    }
  });

  it('no group is declared and then left empty', () => {
    // An empty group renders as a heading with nothing under it. Cheaper to
    // catch here than to notice on screen.
    const used = new Set(SETTING_KEYS.map((key) => SETTINGS[key].group));
    expect([...SETTING_GROUPS].filter((group) => !used.has(group))).toEqual([]);
  });
});

describe('every number control names a unit both catalogues can render', () => {
  it.each(SETTING_KEYS)('%s', (key) => {
    const { control } = SETTINGS[key];
    if (control.kind !== 'number') return;
    expect(Object.keys(EN_MESSAGES)).toContain(control.unitToken);
    expect(Object.keys(HI_MESSAGES)).toContain(control.unitToken);
    expect(control.min).toBeLessThan(control.max);
  });
});

describe('the key helpers', () => {
  it('recognises exactly the declared keys', () => {
    for (const key of SETTING_KEYS) expect(isSettingKey(key)).toBe(true);
    expect(isSettingKey('security.somethingElse')).toBe(false);
    expect(isSettingKey('__proto__')).toBe(false);
  });

  it('declares no secret setting today, so the sealed read path has no live key', () => {
    expect(SETTING_KEYS.filter(isSecretSetting)).toEqual([]);
  });
});
