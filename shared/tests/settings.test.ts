/**
 * The settings declaration table's own contract.
 *
 * Pure — no database, no server. Two things are checked, and both are the kind
 * that only bite in production: a key whose label the Settings screen cannot
 * render, and a parser that rejects the very default it ships with (which would
 * make `getSetting` log a warning and fall back on every single read).
 */

import { describe, expect, it } from 'vitest';

import { EN_MESSAGES, HI_MESSAGES, SETTINGS, SETTING_KEYS, isSecretSetting, isSettingKey } from '../src/index.js';

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
  };

  it.each(SETTING_KEYS)('%s throws on a value it cannot mean', (key) => {
    expect(Object.keys(WRONG)).toContain(key);
    expect(() => SETTINGS[key].parse(WRONG[key])).toThrow();
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
