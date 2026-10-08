/** The notice board's shared rules: validation, order, expiry, and how a change reaches a panel. */

import { describe, expect, it } from 'vitest';

import {
  CAPABILITIES,
  NOTICE_BODY_MAX,
  NOTICE_TITLE_MAX,
  RECYCLE_BIN_ENTITIES,
  RESTORE_PERMISSION,
  ROLE_TEMPLATES,
  SNAPSHOT_FORCING_ENTITIES,
  applyChangeToSnapshot,
  compareNotices,
  isNoticeExpired,
  isPermittedForTier,
  noticeAtSignIn,
  noticeOnHome,
  noticeProblem,
  noticeToday,
  type Notice,
  type SyncSnapshot,
} from '../src/index.js';

const notice = (over: Partial<Notice>): Notice =>
  ({
    id: 'n',
    pinned: false,
    priority: 'normal',
    createdAt: '2026-10-01T00:00:00.000Z',
    ...over,
  }) as Notice;

describe('noticeProblem', () => {
  it('needs a title to create, and not to edit', () => {
    expect(noticeProblem({ title: '  ' }, 'create')).toBe('title_required');
    expect(noticeProblem({}, 'create')).toBe('title_required');
    expect(noticeProblem({ pinned: true }, 'update')).toBeNull();
    expect(noticeProblem({ title: '' }, 'update')).toBe('title_required');
  });

  it('holds the limits exactly', () => {
    expect(noticeProblem({ title: 'x'.repeat(NOTICE_TITLE_MAX) }, 'create')).toBeNull();
    expect(noticeProblem({ title: 'x'.repeat(NOTICE_TITLE_MAX + 1) }, 'create')).toBe(
      'title_too_long',
    );
    expect(noticeProblem({ title: 't', body: 'x'.repeat(NOTICE_BODY_MAX) }, 'create')).toBeNull();
    expect(noticeProblem({ title: 't', body: 'x'.repeat(NOTICE_BODY_MAX + 1) }, 'create')).toBe(
      'body_too_long',
    );
  });

  it('accepts only real calendar days, and only the two priorities', () => {
    expect(noticeProblem({ title: 't', showUntil: '2026-10-31' }, 'create')).toBeNull();
    expect(noticeProblem({ title: 't', showUntil: '2026-02-31' }, 'create')).toBe('bad_date');
    expect(noticeProblem({ title: 't', showUntil: 'tomorrow' }, 'create')).toBe('bad_date');
    expect(noticeProblem({ title: 't', showUntil: null }, 'create')).toBeNull();
    expect(noticeProblem({ title: 't', priority: 'urgent' as never }, 'create')).toBe(
      'bad_priority',
    );
  });

  it('refuses an empty role audience', () => {
    expect(noticeProblem({ title: 't', audience: { kind: 'roles', roleIds: [] } }, 'create')).toBe(
      'audience_empty',
    );
    expect(noticeProblem({ title: 't', audience: { kind: 'all' } }, 'create')).toBeNull();
  });

  it('keeps a notice on Basic Home, at sign-in, or both, never neither', () => {
    expect(noticeProblem({ title: 't', showOnHome: false, showAtSignIn: false }, 'create')).toBe(
      'no_placement',
    );
    expect(noticeProblem({ showOnHome: false, showAtSignIn: false }, 'update')).toBe(
      'no_placement',
    );
    expect(noticeProblem({ title: 't', showOnHome: false }, 'create')).toBeNull();
    expect(noticeProblem({ title: 't', showAtSignIn: false }, 'create')).toBeNull();
  });

  it('reads a placement an older Master never sent as shown', () => {
    expect(noticeOnHome({})).toBe(true);
    expect(noticeAtSignIn({})).toBe(true);
    expect(noticeOnHome({ showOnHome: false })).toBe(false);
    expect(noticeAtSignIn({ showAtSignIn: false })).toBe(false);
  });
});

describe('order and expiry', () => {
  it('sorts pinned first, then important, then newest', () => {
    const list = [
      notice({ id: 'old', createdAt: '2026-09-01T00:00:00.000Z' }),
      notice({ id: 'new', createdAt: '2026-10-02T00:00:00.000Z' }),
      notice({ id: 'important', priority: 'important' }),
      notice({ id: 'pinned', pinned: true }),
    ];
    expect([...list].sort(compareNotices).map((n) => n.id)).toEqual([
      'pinned',
      'important',
      'new',
      'old',
    ]);
  });

  it('shows through the last day, and never expires without one', () => {
    expect(isNoticeExpired('2026-10-06', '2026-10-06')).toBe(false);
    expect(isNoticeExpired('2026-10-05', '2026-10-06')).toBe(true);
    expect(isNoticeExpired(null, '2099-01-01')).toBe(false);
  });

  it('reads today in the company’s time zone', () => {
    const instant = new Date('2026-10-06T20:00:00Z');
    expect(noticeToday(instant, 'Asia/Kolkata')).toBe('2026-10-07');
    expect(noticeToday(instant, 'UTC')).toBe('2026-10-06');
  });
});

describe('how the board is wired into the rest', () => {
  it('a notice change makes a panel take a fresh snapshot, never folds the event in', () => {
    expect(SNAPSHOT_FORCING_ENTITIES).toContain('notice');
    const snapshot = {
      parties: [],
      leads: [],
      orders: [],
      products: [],
      categories: [],
    } as unknown as SyncSnapshot;
    expect(
      applyChangeToSnapshot(snapshot, {
        entity: 'notice',
        action: 'created',
        id: 'n',
        payload: { audience: { kind: 'all' } },
      }),
    ).toBe('refresh');
  });

  it('is restorable from the Recycle Bin with notices.manage', () => {
    expect(RECYCLE_BIN_ENTITIES).toContain('notice');
    expect(RESTORE_PERMISSION.notice).toBe('notices.manage');
  });

  it('reading is for every tier, managing for administrators, and both are in the capability list', () => {
    expect(isPermittedForTier('notices.view', 'office')).toBe(true);
    expect(isPermittedForTier('notices.manage', 'management')).toBe(false);
    expect(isPermittedForTier('notices.manage', 'admin')).toBe(true);
    expect(CAPABILITIES.filter((c) => c.group === 'notices').map((c) => c.key)).toEqual([
      'notices.view',
      'notices.manage',
    ]);
  });

  it('the shipped role templates can read the board', () => {
    for (const template of ROLE_TEMPLATES) expect(template.permissions).toContain('notices.view');
  });
});
