/**
 * `AvatarStack`: who else has a record open. The reader is never shown to
 * themselves, an editor wears the accent ring, a Server Master carries the
 * shield, and past four faces the rest fold into a `+N` chip.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { PresenceEntry } from '@orderbook/shared';

import { AvatarStack } from '../src/AvatarStack.js';
import { t } from '../src/i18n.js';

afterEach(cleanup);

function person(userId: string, displayName: string, extra: Partial<PresenceEntry> = {}): PresenceEntry {
  return {
    userId,
    displayName,
    avatar: null,
    tier: 'office',
    editing: false,
    since: '2026-10-03T09:00:00.000Z',
    ...extra,
  };
}

describe('AvatarStack', () => {
  it('leaves the reader out, and renders nothing when nobody else is there', () => {
    const { container } = render(
      <AvatarStack entries={[person('me', 'Asha Rao')]} selfUserId="me" />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('says who is viewing and who is editing, and rings the editor', () => {
    render(
      <AvatarStack
        entries={[person('me', 'Asha Rao'), person('u2', 'Ravi Kumar', { editing: true }), person('u3', 'Meena Shah')]}
        selfUserId="me"
      />,
    );
    const group = screen.getByRole('group', { name: t('presence.label') });
    expect(group).toBeTruthy();
    const editor = screen.getByTitle(t('presence.editing', { name: 'Ravi Kumar' }));
    expect(editor.getAttribute('data-editing')).toBe('true');
    const viewer = screen.getByTitle(t('presence.viewing', { name: 'Meena Shah' }));
    expect(viewer.getAttribute('data-editing')).toBeNull();
    expect(screen.queryByTitle(t('presence.viewing', { name: 'Asha Rao' }))).toBeNull();
  });

  it('marks a Server Master with the shield', () => {
    const { container } = render(
      <AvatarStack entries={[person('sm', 'Owner', { tier: 'server_master' }), person('u2', 'Ravi')]} />,
    );
    const badges = container.querySelectorAll('[data-server-master]');
    expect(badges).toHaveLength(1);
    expect(badges[0]?.getAttribute('title')).toBe(t('presence.serverMaster'));
  });

  it('shows four faces, then folds the rest into a +N chip', () => {
    const entries = ['A', 'B', 'C', 'D', 'E', 'F'].map((name) => person(`u-${name}`, `Person ${name}`));
    const { container } = render(<AvatarStack entries={entries} />);
    expect(container.querySelectorAll('.ob-avatarstack-item')).toHaveLength(4);
    const more = screen.getByLabelText(t('presence.more', { count: 2 }));
    expect(more.textContent).toBe('+2');
  });
});
