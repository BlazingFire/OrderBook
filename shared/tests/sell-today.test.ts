/**
 * "Sell today" (2026-10-08): the rules both panels and the Master share — what an entry must hold,
 * which entry is the day's, and how a sub product becomes a card.
 */

import { describe, expect, it } from 'vitest';

import {
  COMMAND_MIN_PROTOCOL,
  PANEL_PROTOCOL_VERSION,
  SELL_TODAY_MIN_PROTOCOL,
  isSellTodayAutoClose,
  sellTodayApplies,
  sellTodayFor,
  sellTodayProblem,
  sellTodayProductOf,
  type Product,
  type SellToday,
} from '../src/index.js';

const entry = (id: string, over: Partial<SellToday> = {}): SellToday => ({
  id,
  tenantId: 't1',
  title: id,
  body: '',
  productIds: [],
  products: [],
  autoCloseSeconds: 15,
  showFrom: null,
  showUntil: null,
  audience: { kind: 'all' },
  authorId: null,
  authorName: null,
  createdAt: '2026-10-08T08:00:00.000Z',
  updatedAt: '2026-10-08T08:00:00.000Z',
  version: 1,
  ...over,
});

describe('sellTodayProblem', () => {
  it('wants a headline and something to sell on a create', () => {
    expect(sellTodayProblem({ title: ' ', productIds: ['P1'] }, 'create')).toBe('title_required');
    expect(sellTodayProblem({ title: 'x'.repeat(121), productIds: ['P1'] }, 'create')).toBe('title_too_long');
    expect(sellTodayProblem({ title: 'Push' }, 'create')).toBe('nothing_to_sell');
    expect(sellTodayProblem({ title: 'Push', body: '   ' }, 'create')).toBe('nothing_to_sell');
    expect(sellTodayProblem({ title: 'Push', body: 'A message alone is enough' }, 'create')).toBeNull();
    expect(sellTodayProblem({ title: 'Push', productIds: ['P1'] }, 'create')).toBeNull();
  });

  it('checks an edit on what it sends', () => {
    expect(sellTodayProblem({ autoCloseSeconds: 30 }, 'update')).toBeNull();
    expect(sellTodayProblem({ title: '' }, 'update')).toBe('title_required');
  });

  it('bounds the products, the seconds, the dates and the audience', () => {
    const base = { title: 'Push', productIds: ['P1'] };
    expect(sellTodayProblem({ ...base, productIds: Array.from({ length: 13 }, (_, i) => `P${i}`) }, 'create')).toBe(
      'too_many_products',
    );
    expect(sellTodayProblem({ ...base, productIds: Array.from({ length: 12 }, (_, i) => `P${i}`) }, 'create')).toBeNull();
    expect(sellTodayProblem({ ...base, autoCloseSeconds: 4 }, 'create')).toBe('bad_auto_close');
    expect(sellTodayProblem({ ...base, showFrom: '2026-02-31' }, 'create')).toBe('bad_date');
    expect(sellTodayProblem({ ...base, showFrom: '2026-10-09', showUntil: '2026-10-08' }, 'create')).toBe(
      'dates_reversed',
    );
    expect(sellTodayProblem({ ...base, showFrom: '2026-10-08', showUntil: '2026-10-08' }, 'create')).toBeNull();
    expect(sellTodayProblem({ ...base, audience: { kind: 'roles', roleIds: [] } }, 'create')).toBe('audience_empty');
  });
});

describe('isSellTodayAutoClose', () => {
  it('takes 0 or a whole 5 to 120', () => {
    expect([0, 5, 15, 120].every(isSellTodayAutoClose)).toBe(true);
    expect([-1, 1, 4, 121, 7.5, Number.NaN, '10'].some(isSellTodayAutoClose)).toBe(false);
  });
});

describe('the day’s entry', () => {
  it('applies from its first day to its last, both included', () => {
    const window = { showFrom: '2026-10-08', showUntil: '2026-10-09' };
    expect(sellTodayApplies(window, '2026-10-07')).toBe(false);
    expect(sellTodayApplies(window, '2026-10-08')).toBe(true);
    expect(sellTodayApplies(window, '2026-10-09')).toBe(true);
    expect(sellTodayApplies(window, '2026-10-10')).toBe(false);
    expect(sellTodayApplies({ showFrom: null, showUntil: null }, '2030-01-01')).toBe(true);
  });

  it('is the newest of those that apply, and none when none does', () => {
    const older = entry('older', { createdAt: '2026-10-08T07:00:00.000Z' });
    const newer = entry('newer', { createdAt: '2026-10-08T09:00:00.000Z' });
    const later = entry('later', { createdAt: '2026-10-08T10:00:00.000Z', showFrom: '2026-10-09' });

    expect(sellTodayFor([older, later, newer], '2026-10-08')?.id).toBe('newer');
    expect(sellTodayFor([older, later, newer], '2026-10-09')?.id).toBe('later');
    expect(sellTodayFor([entry('ended', { showUntil: '2026-10-07' })], '2026-10-08')).toBeNull();
    expect(sellTodayFor(undefined, '2026-10-08')).toBeNull();
  });
});

describe('sellTodayProductOf', () => {
  it('takes the first active code, the main product and the primary photo', () => {
    const image = (id: string, isPrimary: boolean) => ({ id, isPrimary, blurhash: 'L', sequence: 0 }) as never;
    const product = {
      id: 'PR1',
      name: 'DAMRU',
      size: '600 x 400',
      categoryName: 'Table Top Basin',
      variants: [
        { code: 'OLD-1', isActive: false },
        { code: 'OPT-0001', isActive: true },
      ],
      images: [image('IMG-2', false), image('IMG-1', true)],
    } as unknown as Product;

    expect(sellTodayProductOf(product)).toMatchObject({
      id: 'PR1',
      name: 'DAMRU',
      code: 'OPT-0001',
      size: '600 x 400',
      mainProduct: 'Table Top Basin',
      image: { id: 'IMG-1' },
    });
    expect(sellTodayProductOf({ ...product, images: [], categoryName: '' }).image).toBeNull();
    expect(sellTodayProductOf({ ...product, images: [], categoryName: '' }).mainProduct).toBeNull();
  });
});

describe('the protocol', () => {
  it('speaks the sell-today commands, each gated at their protocol', () => {
    expect(PANEL_PROTOCOL_VERSION).toBeGreaterThanOrEqual(SELL_TODAY_MIN_PROTOCOL);
    for (const command of ['sellToday:manageList', 'sellToday:create', 'sellToday:update'] as const)
      expect(COMMAND_MIN_PROTOCOL[command]).toBe(SELL_TODAY_MIN_PROTOCOL);
  });
});
