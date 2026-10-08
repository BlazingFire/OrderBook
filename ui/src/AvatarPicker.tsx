/**
 * Choosing, replacing and clearing a profile picture.
 *
 * The file is sent as-is and squared on the Master, rather than cropped here
 * first. A crop editor is the right call for a product photo, where which part
 * of the frame you keep is a real decision; for a face it is a step between
 * somebody and the thing they wanted, and a centre crop is what they would have
 * chosen nine times in ten. The size and type checks still happen here, because
 * failing before a 5MB upload beats failing after it.
 */

import { useRef, useState } from 'react';
import { AVATAR_LONG_EDGE, MAX_AVATAR_SOURCE_BYTES, type User } from '@orderbook/shared';

import { t } from './i18n.js';
import { Avatar } from './Avatar';
import { Button } from './Button';

/** Why a chosen file cannot be a profile picture, or null when it can be sent. */
export function avatarFileProblem(file: File): string | null {
  if (!file.type.startsWith('image/')) return t('avatar.error.notAnImage');
  if (file.size > MAX_AVATAR_SOURCE_BYTES) return t('avatar.error.tooLarge');
  return null;
}

export function AvatarPicker({
  user,
  canEdit,
  onUpload,
  onRemove,
}: {
  user: User;
  canEdit: boolean;
  onUpload: (file: File) => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function choose(file: File | undefined): Promise<void> {
    if (!file) return;
    const problem = avatarFileProblem(file);
    setFailure(problem);
    if (problem) return;

    setBusy(true);
    try {
      await onUpload(file);
    } catch (caught) {
      setFailure(caught instanceof Error ? caught.message : t('avatar.error.uploadFailed'));
    } finally {
      setBusy(false);
      // Cleared so choosing the same file twice still fires a change event —
      // which is exactly what somebody does after a failure.
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <div className="ob-avatarpicker">
      <Avatar name={user.displayName} avatar={user.avatar} size="lg" />

      <div className="ob-avatarpicker-body">
        {canEdit && (
          <div className="ob-detail-actions">
            <Button
              variant="secondary"
              size="sm"
              busy={busy}
              onClick={() => inputRef.current?.click()}
            >
              {user.avatar ? t('avatar.change') : t('avatar.choose')}
            </Button>
            {user.avatar && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setFailure(null);
                  setBusy(true);
                  void onRemove()
                    .catch((caught: unknown) =>
                      setFailure(
                        caught instanceof Error ? caught.message : t('avatar.error.removeFailed'),
                      ),
                    )
                    .finally(() => setBusy(false));
                }}
              >
                {t('avatar.remove')}
              </Button>
            )}
          </div>
        )}

        <p className="ob-small" style={{ margin: 0, color: 'var(--fg-tertiary)' }}>
          {t('avatar.hint', {
            px: AVATAR_LONG_EDGE,
            max: `${MAX_AVATAR_SOURCE_BYTES / (1024 * 1024)} MB`,
          })}
        </p>
        {failure && (
          <p
            className="ob-small"
            style={{ margin: 0, color: 'var(--state-conflict)' }}
            role="alert"
          >
            {failure}
          </p>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="sr-only"
        aria-label={t('avatar.choose')}
        onChange={(event) => void choose(event.target.files?.[0])}
      />
    </div>
  );
}
