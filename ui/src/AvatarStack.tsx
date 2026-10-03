/**
 * Who else has this record open (1.3 rule 3).
 *
 * Sits top right in a record's header. Up to four faces overlap, then a `+N`
 * chip; an accent ring around a face means that person is editing, and a
 * small shield marks a Server Master. The reader is left out: they know they
 * are here. Nothing renders when nobody else is.
 */

import type { PresenceEntry } from '@orderbook/shared';

import { Avatar, type AvatarSize } from './Avatar.js';
import { Icon } from './icons.js';
import { t } from './i18n.js';

const SHOWN = 4;

/** On a board card or row (R22): three small faces, so the card keeps its room. */
export const BOARD_SHOWN = 3;

export function AvatarStack({
  entries,
  selfUserId,
  max = SHOWN,
  size = 'sm',
}: {
  entries: readonly PresenceEntry[];
  /** The signed-in person, never shown to themselves. */
  selfUserId?: string | null;
  /** Faces before the `+N` chip. */
  max?: number;
  size?: AvatarSize;
}) {
  const others = entries.filter((entry) => entry.userId !== selfUserId);
  if (others.length === 0) return null;

  const shown = others.slice(0, max);
  const hidden = others.slice(max);

  return (
    <span className="ob-avatarstack" role="group" aria-label={t('presence.label')}>
      {shown.map((entry) => {
        const label = t(entry.editing ? 'presence.editing' : 'presence.viewing', {
          name: entry.displayName,
        });
        return (
          <span
            key={entry.userId}
            className="ob-avatarstack-item"
            data-editing={entry.editing || undefined}
            title={label}
            aria-label={label}
          >
            <Avatar name={entry.displayName} avatar={entry.avatar} size={size} />
            {entry.tier === 'server_master' && (
              <span
                className="ob-avatarstack-badge"
                data-server-master=""
                title={t('presence.serverMaster')}
              >
                <Icon name="shield" size={9} />
              </span>
            )}
          </span>
        );
      })}
      {hidden.length > 0 && (
        <span
          className="ob-avatarstack-more"
          title={hidden.map((entry) => entry.displayName).join(', ')}
          aria-label={t('presence.more', { count: hidden.length })}
        >
          +{hidden.length}
        </span>
      )}
    </span>
  );
}
