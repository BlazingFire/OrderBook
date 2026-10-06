/**
 * Who is told of a notice change. Pure: `mayReceive` over actors built by hand.
 *
 * A change names only its audience. A recipient outside it is told nothing; a manager is told
 * everything; one without `notices.view` is told nothing at all.
 */

import { describe, expect, it } from 'vitest';
import type { DataChangedEvent } from '@orderbook/shared';

import type { ActorContext } from '../src/domain/actor.js';
import { mayReceive } from '../src/realtime/fan-out.js';

const actor = (roleId: string | null, permissions: string[]): ActorContext =>
  ({
    tenantId: 't1',
    actorType: 'user',
    actorId: 'US1',
    userId: 'US1',
    permissions: { roleId, roleName: 'r', tier: 'office', permissions },
    deviceCode: null,
    actorName: 'x',
  }) as never;

const change = (audience: unknown): DataChangedEvent => ({
  entity: 'notice',
  action: 'updated',
  id: 'N1',
  payload: { audience },
});

describe('a notice change reaches only its audience', () => {
  it('everybody with notices.view is told of a notice for everybody', () => {
    expect(mayReceive(actor('RL1', ['notices.view']), change({ kind: 'all' }), [])).toBe(true);
    expect(mayReceive(actor(null, ['notices.view']), change({ kind: 'all' }), [])).toBe(true);
  });

  it('a notice for roles is told to those roles and nobody else', () => {
    const audience = { kind: 'roles', roleIds: ['RL1'] };

    expect(mayReceive(actor('RL1', ['notices.view']), change(audience), [])).toBe(true);
    expect(mayReceive(actor('RL2', ['notices.view']), change(audience), [])).toBe(false);
    expect(mayReceive(actor(null, ['notices.view']), change(audience), [])).toBe(false);
  });

  it('a manager is told of every change', () => {
    const audience = { kind: 'roles', roleIds: ['RL1'] };
    expect(mayReceive(actor('RL9', ['notices.view', 'notices.manage']), change(audience), [])).toBe(
      true,
    );
  });

  it('nobody without notices.view is told anything, a manager without it included', () => {
    expect(mayReceive(actor('RL1', ['leads.view']), change({ kind: 'all' }), [])).toBe(false);
    expect(mayReceive(actor('RL1', ['notices.manage']), change({ kind: 'all' }), [])).toBe(false);
  });

  it('a payload that names no audience is told to nobody who does not manage', () => {
    expect(mayReceive(actor('RL1', ['notices.view']), { ...change(null), payload: null }, [])).toBe(
      false,
    );
    expect(
      mayReceive(actor('RL1', ['notices.view']), change({ kind: 'roles', roleIds: 'RL1' }), []),
    ).toBe(false);
  });
});

import { noticeEventFor } from '../src/realtime/fan-out.js';

describe('what a recipient is told of a notice change', () => {
  const full = change({ kind: 'roles', roleIds: ['RL1', 'RL2', 'RL3'] });

  it('a reader is told only that it is for their own role, never which other roles it names', () => {
    const told = noticeEventFor(actor('RL2', ['notices.view']), full);

    expect(told.payload).toEqual({ audience: { kind: 'roles', roleIds: ['RL2'] } });
    expect(JSON.stringify(told)).not.toContain('RL1');
    expect(JSON.stringify(told)).not.toContain('RL3');
  });

  it('a notice for everybody is told as it is, and a manager is told the whole audience', () => {
    const everyone = change({ kind: 'all' });
    expect(noticeEventFor(actor('RL2', ['notices.view']), everyone)).toBe(everyone);
    expect(noticeEventFor(actor('RL9', ['notices.view', 'notices.manage']), full)).toBe(full);
  });

  it('leaves every other entity alone', () => {
    const other: DataChangedEvent = {
      entity: 'lead',
      action: 'updated',
      id: 'L1',
      payload: { x: 1 },
    };
    expect(noticeEventFor(actor('RL2', ['notices.view']), other)).toBe(other);
  });
});

describe('a panel acting as itself', () => {
  const panel = (roleId: string | null): ActorContext =>
    ({
      ...actor(roleId, ['notices.view']),
      actorType: 'office_panel',
      actorId: 'OP1',
      userId: null,
    }) as never;

  it('is told of notices for everybody and never of a role’s, whatever role the panel holds', () => {
    expect(mayReceive(panel('RL1'), change({ kind: 'all' }), [])).toBe(true);
    expect(mayReceive(panel('RL1'), change({ kind: 'roles', roleIds: ['RL1'] }), [])).toBe(false);
  });

  it('is told, of a notice for roles, nothing that names a role', () => {
    const told = noticeEventFor(panel('RL1'), change({ kind: 'roles', roleIds: ['RL1', 'RL2'] }));
    expect(told.payload).toEqual({ audience: { kind: 'roles', roleIds: [] } });
  });
});
