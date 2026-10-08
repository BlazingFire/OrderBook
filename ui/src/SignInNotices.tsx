/**
 * Unread notices, once, right after somebody signs in (V6, both panels).
 *
 * The panel mounts this inside its signed-in shell, so the sign-in screen never shows it and a
 * sign-out unmounts it: the next sign-in decides afresh. It decides once, the first time the
 * person's notices have arrived (`loaded`): every notice placed at sign-in that they have not
 * read, important first and then newest (2026-10-08: it used to take the important ones only).
 * None, or no notices for them at all, and nothing shows. A notice that arrives later in the
 * session waits for the board and the next sign-in, it does not interrupt.
 *
 * "Mark as read" hands the ids to the panel's own read path (the Master posts them; the Office
 * queues them per person while the link is down). "Later" and Escape only close it.
 *
 * A reload while still signed in (F5, an Electron reload) is not a new sign-in: given a
 * `sessionKey`, the decision is remembered in sessionStorage for that sign-in, as a hash of the
 * key in one slot that the next sign-in overwrites.
 */

import { useEffect, useRef, useState } from 'react';
import { noticeAtSignIn, type Notice } from '@orderbook/shared';

import { Button } from './Button.js';
import { StatusPill } from './DataDisplay.js';
import { t } from './i18n.js';
import { Modal } from './Modal.js';
import { boardNotices } from './NoticeBoardView.js';

const DECIDED_SLOT = 'ob.signInNotices.decided';

/** A short non-reversible tag for a sign-in, so nothing of the key itself is stored. */
function tagOf(key: string): string {
  let hash = 5381;
  for (let index = 0; index < key.length; index += 1) hash = ((hash << 5) + hash + key.charCodeAt(index)) | 0;
  return (hash >>> 0).toString(36);
}

function decidedBefore(key: string | undefined): boolean {
  if (!key) return false;
  try {
    return window.sessionStorage.getItem(DECIDED_SLOT) === tagOf(key);
  } catch {
    return false;
  }
}

function rememberDecided(key: string | undefined): void {
  if (!key) return;
  try {
    window.sessionStorage.setItem(DECIDED_SLOT, tagOf(key));
  } catch {
    // No storage (a locked-down profile): a reload asks again, which is the safe side.
  }
}

/** Important first, then newest. */
function signInOrder(a: Notice, b: Notice): number {
  if (a.priority !== b.priority) return a.priority === 'important' ? -1 : 1;
  return b.createdAt.localeCompare(a.createdAt);
}

/** What the pop-up lists: on the board today, placed at sign-in, not read by this person. */
export function signInNotices(notices: readonly Notice[], today?: string): Notice[] {
  return boardNotices(notices, today)
    .filter((notice) => notice.readByMe === false && noticeAtSignIn(notice))
    .sort(signInOrder);
}

export interface SignInNoticesProps {
  /** True once this person's notices have been read after signing in; before that nothing is decided. */
  loaded: boolean;
  notices: readonly Notice[];
  /** Today as `YYYY-MM-DD`, so a notice past its last day is left out. */
  today?: string;
  onMarkRead: (ids: string[]) => void | Promise<void>;
  /** Unique to this sign-in (the person and the session), so a reload does not ask again. */
  sessionKey?: string;
  /**
   * The company's switch (`notices.showAtSignIn`), read when it decides: off then, and this
   * sign-in shows nothing, even if the switch is turned on later in the session; turned off
   * while it is open, it closes.
   */
  enabled?: boolean;
}

export function SignInNotices({
  loaded,
  notices,
  today,
  onMarkRead,
  sessionKey,
  enabled = true,
}: SignInNoticesProps) {
  const decided = useRef(false);
  const [ids, setIds] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!loaded || decided.current) return;
    decided.current = true;
    if (decidedBefore(sessionKey)) return;
    rememberDecided(sessionKey);
    if (!enabled) return;
    const unread = signInNotices(notices, today).map((notice) => notice.id);
    if (unread.length > 0) setIds(unread);
  }, [loaded, notices, today, sessionKey, enabled]);

  if (!ids || !enabled) return null;
  // The ones picked at sign-in, as they stand now (an edit shows), in the same order.
  const listed = notices.filter((notice) => ids.includes(notice.id)).sort(signInOrder);
  if (listed.length === 0) return null;

  const close = () => setIds(null);
  const markRead = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await onMarkRead(listed.map((notice) => notice.id));
      close();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      size="md"
      onClose={close}
      title={t('notices.signIn.title')}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={busy}>
            {t('notices.signIn.later')}
          </Button>
          <Button variant="primary" onClick={() => void markRead()} disabled={busy}>
            {t('notices.signIn.markRead')}
          </Button>
        </>
      }
    >
      <p className="ob-small" style={{ marginTop: 0, color: 'var(--fg-secondary)' }}>
        {t('notices.signIn.intro')}
      </p>
      {failed && (
        <div className="ob-field-error" role="alert">
          {t('notices.signIn.markFailed')}
        </div>
      )}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--s-12)' }}>
        {listed.map((notice) => (
          <li key={notice.id} data-notice={notice.id} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-6)', flexWrap: 'wrap' }}>
              <span className="ob-body-strong" style={{ overflowWrap: 'anywhere' }}>
                {notice.title}
              </span>
              {notice.priority === 'important' && (
                <StatusPill tone="conflict">{t('notices.priority.important')}</StatusPill>
              )}
            </span>
            <span className="ob-small" style={{ color: 'var(--fg-secondary)', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
              {notice.body}
            </span>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
