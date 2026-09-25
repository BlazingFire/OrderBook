/**
 * `t()` / `tCount()` themselves, and `renderActivity()` built on them — not the
 * catalogue's content (`i18n-coverage.test.ts` owns that). Pure: no database,
 * no DOM, no `describe.skipIf` anywhere in this file, so it cannot silently
 * skip.
 */

import { describe, expect, it } from 'vitest';

import { createTranslator, renderActivity, t, tCount } from '../src/index.js';

describe('t()', () => {
  it('substitutes a named placeholder', () => {
    expect(t('en', 'error.notFound', { what: 'Order' })).toBe('Order not found');
  });

  it('substitutes more than one named placeholder regardless of order', () => {
    expect(
      t('en', 'validation.permissions.aboveTier', { tier: 'office', keys: 'roles.delete' }),
    ).toBe('The office tier cannot hold: roles.delete. Raise the tier or remove them.');
  });

  it('leaves an unknown placeholder literally in place rather than blanking it', () => {
    // `t()`'s param type prevents this at compile time for a known key; the
    // runtime behaviour is exercised directly because a `messageKey` off the
    // wire is, by construction, not compiler-checked.
    const rendered = (t as (locale: string, key: string, params: Record<string, unknown>) => string)(
      'en',
      'error.notFound',
      {},
    );
    expect(rendered).toBe('{what} not found');
  });

  it('passes a record id through byte-identical — ids are never reformatted or localised', () => {
    const id = 'LD0000000042';
    expect(t('en', 'error.notFound', { what: id })).toContain(id);
  });

  it('passes a chain hash through byte-identical', () => {
    const hash = 'a3f9c2b1'.repeat(4);
    expect(t('en', 'validation.conflict.cannotRestoreField', { field: hash })).toContain(hash);
  });

  it('renders Hindi from the Hindi catalogue', () => {
    expect(t('hi', 'common.save')).toBe('सहेजें');
  });

  it('falls back to the raw key for a messageKey this bundle does not recognise', () => {
    const rendered = (t as (locale: string, key: string) => string)('en', 'screen.doesNotExistYet');
    expect(rendered).toBe('screen.doesNotExistYet');
  });

  it('never throws for a missing key', () => {
    expect(() =>
      (t as (locale: string, key: string) => string)('en', 'not.a.real.key'),
    ).not.toThrow();
  });
});

describe('tCount()', () => {
  it('selects the singular form for a count of 1', () => {
    expect(tCount('en', 'count.leads', 1)).toBe('1 lead');
  });

  it('selects the plural form for a count other than 1', () => {
    expect(tCount('en', 'count.leads', 0)).toBe('0 leads');
    expect(tCount('en', 'count.leads', 5)).toBe('5 leads');
  });

  it('injects the count as a number, never pre-formatted with a separator', () => {
    expect(tCount('en', 'count.rows', 1000)).toBe('1000 rows');
  });

  it('applies Hindi plural rules through the same mechanism', () => {
    expect(tCount('hi', 'count.rows', 1)).toBe('1 पंक्ति');
    expect(tCount('hi', 'count.rows', 3)).toBe('3 पंक्तियाँ');
  });
});

describe('createTranslator()', () => {
  it('binds the locale so callers do not pass it on every call', () => {
    const translator = createTranslator('hi');
    expect(translator.locale).toBe('hi');
    expect(translator.t('common.cancel')).toBe('रद्द करें');
  });

  it('exposes tCount bound to the same locale', () => {
    const translator = createTranslator('en');
    expect(translator.tCount('count.leads', 2)).toBe('2 leads');
  });
});

describe('renderActivity()', () => {
  const row = {
    entityType: 'party',
    action: 'created',
    actorName: null,
    details: { name: 'Sharma Tiles' },
  };

  it('names a row with no recorded actor in the reader’s own language', () => {
    expect(renderActivity(createTranslator('en'), row)).toBe(
      'Somebody added the party Sharma Tiles',
    );
    // The stand-in was a hard-coded English word, so a Hindi reader got
    // "Somebody ने पार्टी … जोड़ी". Every Hindi template puts a postposition
    // after `{actor}` (`{actor} ने …`), which wants the oblique `किसी`, not `कोई`.
    expect(renderActivity(createTranslator('hi'), row)).toBe('किसी ने पार्टी Sharma Tiles जोड़ी');
  });

  it('uses the recorded name when there is one', () => {
    expect(renderActivity(createTranslator('hi'), { ...row, actorName: 'Karan' })).toBe(
      'Karan ने पार्टी Sharma Tiles जोड़ी',
    );
  });
});
