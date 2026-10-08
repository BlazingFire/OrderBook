/**
 * A person's face, or their initials when there isn't one.
 *
 * The initials are not a placeholder waiting to be replaced — most people never
 * upload a picture, so this is the normal state and has to look deliberate. The
 * tint is derived from the name rather than random, so the same person is the
 * same colour on every screen and in every session; that consistency is what
 * makes a roster scannable at a glance.
 */

import { useState } from 'react';
import { rem } from './rem.js';
import type { UserAvatar } from '@orderbook/shared';

/** Pixel size per step, and the stored variant each one should fetch. */
const SIZES = {
  /** The status footer is 26px tall, so anything larger would not fit in it. */
  xs: { px: 16, variant: 'micro' },
  sm: { px: 24, variant: 'micro' },
  md: { px: 40, variant: 'thumb' },
  /** The person screen's header. */
  ml: { px: 56, variant: 'thumb' },
  lg: { px: 96, variant: 'thumb' },
  xl: { px: 160, variant: 'full' },
} as const;

export type AvatarSize = keyof typeof SIZES;

/**
 * Six tints from the ramp, picked by a stable hash of the name. Not the accent:
 * a wall of accent-coloured circles would compete with every real control on
 * the screen.
 */
const TINTS = 6;

export function Avatar({
  name,
  avatar,
  size = 'sm',
  src,
  highlight,
}: {
  name: string;
  /**
   * Undefined as well as null, and the difference is not academic. A Master and
   * its panels update independently, so a panel built with this field can be
   * talking to a Master whose `User` payload predates it — the key is then
   * absent, not null. Testing `!== null` passed for `undefined` and read `.id`
   * off it, which threw inside a component the status footer renders on every
   * screen and took the whole app down to a blank window.
   */
  avatar: UserAvatar | null | undefined;
  size?: AvatarSize;
  /**
   * Where the picture actually is, for the one case the default cannot cover.
   *
   * The Office panel's sign-in screen draws faces from its own cache, because
   * it renders with nobody signed in — before this panel's server can proxy
   * anything to a Master it may not even be able to reach yet. Everything
   * else uses the default: `/uploads/avatars/:id/:variant` is a same-origin
   * relative path that each panel's own server answers locally (the Master
   * reads its disk directly; the Office Panel serves from its own cache and
   * fetches from the Master on a miss, the same pattern `ProgressiveImage`
   * uses for product photos), so one URL works unmodified on both.
   */
  src?: string;
  /** A ring marking a Server Master, wherever their face appears. */
  highlight?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const { px, variant } = SIZES[size];

  const initials = initialsOf(name);
  const showImage = Boolean(avatar ?? src) && !failed;

  return (
    <span
      className="ob-avatar"
      data-tint={showImage ? undefined : tintOf(name)}
      data-highlight={highlight || undefined}
      // In rem, so a face grows with the app scale like the text beside it;
      // initials at 0.46 of the disc with an 8 px floor (0.4 drew them at 10 px
      // in the 24 px disc, and 6 px in the board's 16 px stacks).
      style={{ width: rem(px), height: rem(px), fontSize: rem(Math.max(8, Math.round(px * 0.46))) }}
      title={name}
    >
      {showImage ? (
        <img
          // Keyed on the source so replacing a picture swaps the element rather
          // than leaving a failed `img` in its error state.
          key={src ?? avatar?.id}
          src={src ?? `/uploads/avatars/${avatar?.id}/${variant}`}
          alt=""
          width={px}
          height={px}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      ) : (
        <span aria-hidden="true">{initials}</span>
      )}
      <span className="sr-only">{name}</span>
    </span>
  );
}

/** First letters of the first and last words — "Akshit Verma" reads as AV; a word that starts with punctuation is skipped, so "Admin (test)" is A, not A(. */
function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter((word) => /^[\p{L}\p{N}]/u.test(word));
  if (words.length === 0) return '?';
  const first = words[0] ?? '';
  const last = words.length > 1 ? (words[words.length - 1] ?? '') : '';
  return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase();
}

/** Stable across sessions and machines: same name, same colour, always. */
function tintOf(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) % 100_000;
  }
  return hash % TINTS;
}
