/**
 * The size and type checks for a profile picture, made before the upload (the
 * Master squares it): failing before a 5MB upload beats failing after it.
 */

import { MAX_AVATAR_SOURCE_BYTES } from '@orderbook/shared';

import { t } from './i18n.js';

/** Why a chosen file cannot be a profile picture, or null when it can be sent. */
export function avatarFileProblem(file: File): string | null {
  if (!file.type.startsWith('image/')) return t('avatar.error.notAnImage');
  if (file.size > MAX_AVATAR_SOURCE_BYTES) return t('avatar.error.tooLarge');
  return null;
}
