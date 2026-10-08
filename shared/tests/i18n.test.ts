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
    expect(tCount('en', 'count.leads', 1)).toBe('1 pending order');
  });

  it('selects the plural form for a count other than 1', () => {
    expect(tCount('en', 'count.leads', 0)).toBe('0 pending orders');
    expect(tCount('en', 'count.leads', 5)).toBe('5 pending orders');
  });

  it('injects the count as a number, never pre-formatted with a separator', () => {
    expect(tCount('en', 'count.rows', 1000)).toBe('1000 rows');
  });
});

describe('createTranslator()', () => {
  it('binds the locale so callers do not pass it on every call', () => {
    const translator = createTranslator('en');
    expect(translator.locale).toBe('en');
    expect(translator.t('common.cancel')).toBe('Cancel');
  });

  it('exposes tCount bound to the same locale', () => {
    const translator = createTranslator('en');
    expect(translator.tCount('count.leads', 2)).toBe('2 pending orders');
  });
});

describe('renderActivity()', () => {
  const row = {
    entityType: 'party',
    action: 'created',
    actorName: null,
    details: { name: 'Sharma Tiles' },
  };

  it('names a row with no recorded actor from the catalogue', () => {
    expect(renderActivity(createTranslator('en'), row)).toBe(
      'Somebody added the party Sharma Tiles',
    );
  });

  it("fills a new account's {name} from its displayName, then its username", () => {
    const created = { entityType: 'user', action: 'created', actorName: 'Karan' };
    expect(
      renderActivity(createTranslator('en'), {
        ...created,
        details: { username: 'ayush', displayName: 'Ayush' },
      }),
    ).toBe('Karan created the account for Ayush');
    expect(
      renderActivity(createTranslator('en'), { ...created, details: { username: 'ayush' } }),
    ).toBe('Karan created the account for ayush');
  });

  it('uses the recorded name when there is one', () => {
    expect(renderActivity(createTranslator('en'), { ...row, actorName: 'Karan' })).toBe(
      'Karan added the party Sharma Tiles',
    );
  });

  it('uses the activityDetail.* sentence when the row carries every field it names', () => {
    const deleted = {
      entityType: 'lead',
      action: 'deleted',
      actorName: 'Karan',
      details: { number: 'LD0000000007', party: 'Sharma Tiles' },
    };
    expect(renderActivity(createTranslator('en'), deleted)).toBe(
      'Karan deleted the pending order LD0000000007 for Sharma Tiles',
    );
    // A row written before those fields existed keeps its plain sentence.
    expect(renderActivity(createTranslator('en'), { ...deleted, details: {} })).toBe(
      'Karan deleted this pending order',
    );
  });

  it('translates *Token details, so a setting change names its label and values', () => {
    const changed = {
      entityType: 'setting',
      action: 'updated',
      actorName: 'Karan',
      details: {
        name: 'security.offlineSignInEnabled',
        labelToken: 'setting.security.offlineSignInEnabled.label',
        from: 'true',
        to: 'false',
        fromToken: 'settingValue.on',
        toToken: 'settingValue.off',
      },
    };
    expect(renderActivity(createTranslator('en'), changed)).toBe(
      'Karan changed Allow signing in while the Master Panel is off from On to Off',
    );
    // A *Token value that is not a message key is left alone, never looked up
    // on the object's prototype.
    expect(
      renderActivity(createTranslator('en'), {
        ...changed,
        details: { name: 'x', labelToken: 'toString', from: '1', to: '2' },
      }),
    ).toBe('Karan changed the setting x');
  });
});
