/**
 * Change your own password.
 *
 * The endpoint (`POST /api/access/me/password`) and its client wrapper have
 * been complete and audited since the access work landed, and **nothing in
 * either panel ever called them**. Every password change went through an
 * administrator resetting somebody else's — so the most routine account action
 * in the product was an admin bottleneck, and an administrator changing their
 * own had no route at all.
 *
 * `authService.changeOwnPassword` ends with `invalidateSessionsForUser(userId)`
 * with no exception for the caller's own session, so succeeding here signs this
 * window out. That is correct — a password change should not leave old sessions
 * alive — but it has to be *said* before the button is pressed, and the window
 * has to land on the sign-in screen with a reason rather than falling over on
 * its next request. The 401 path in `api.ts` publishes that reason;
 * `App.tsx` listens.
 *
 * A Server Master's own change also needs the master key: it is checked first
 * (`/api/master-key/verify`), and the token it buys rides on the change.
 */

import { useState } from 'react';

import { api } from '../api';
import {
  Button,
  FieldError,
  FormField,
  Modal,
  apiErrorText,
  publishSessionEnded,
  t,
  PasswordInput,
  useUnsavedWork,
} from '@orderbook/ui';

/** The server's own floor (`validation.password.tooShort`), checked here too. */
const MIN_LENGTH = 8;

export function ChangePasswordDialog({
  open,
  onClose,
  serverMaster = false,
}: {
  open: boolean;
  onClose: () => void;
  /** The signed-in user is a Server Master, so the master key is asked for too. */
  serverMaster?: boolean;
}) {
  const [masterKey, setMasterKey] = useState('');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // "Save all and update": named, never submitted. Changing a password signs the
  // person out of this window, which is not something to do in the middle of an
  // update, and a password is not typed twice for a machine to finish.
  useUnsavedWork(
    'change-password',
    open && (current || next || confirm) ? { label: t('updates.saveAll.password') } : null,
  );

  function close(): void {
    setMasterKey('');
    setCurrent('');
    setNext('');
    setConfirm('');
    setError(null);
    onClose();
  }

  async function submit(): Promise<void> {
    if (next.length < MIN_LENGTH) {
      setError(t('validation.password.tooShort'));
      return;
    }
    if (next !== confirm) {
      setError(t('access.changePassword.mismatch'));
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const token = serverMaster ? (await api.verifyMasterKey(masterKey)).token : undefined;
      await api.changeOwnPassword({ currentPassword: current, newPassword: next }, token);
      // No success toast: this window's own session ended with the change, and
      // a toast that outlives the screen it was raised on reads as a bug. Ending
      // it here, with the reason, lands on sign-in saying what happened instead
      // of waiting for the next request to come back 401.
      close();
      publishSessionEnded('signIn.notice.passwordChanged');
    } catch (caught) {
      // Named, not generic — a wrong current password is the common case and
      // the server says so specifically.
      setError(apiErrorText(caught, 'access.changePassword.failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      size="sm"
      title={t('access.changePassword.title')}
      footer={
        <>
          <span style={{ flex: 1 }} />
          <Button variant="secondary" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            busy={busy}
            disabled={!current || !next || !confirm || (serverMaster && !masterKey)}
            onClick={() => void submit()}
          >
            {t('access.changePassword.submit')}
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
        <p className="ob-small" style={{ margin: 0 }}>
          {t('access.changePassword.signsYouOut')}
        </p>

        {serverMaster && (
          <FormField label={t('masterKey.label')} hint={t('masterKey.help')}>
            {(id) => (
              <PasswordInput
                id={id}
                value={masterKey}
                autoComplete="off"
                autoFocus
                onChange={(event) => setMasterKey(event.target.value)}
              />
            )}
          </FormField>
        )}
        <FormField label={t('access.changePassword.current')}>
          {(id) => (
            <PasswordInput
              id={id}
              value={current}
              autoComplete="current-password"
              autoFocus={!serverMaster}
              onChange={(event) => setCurrent(event.target.value)}
            />
          )}
        </FormField>
        <FormField label={t('access.changePassword.new')}>
          {(id) => (
            <PasswordInput
              id={id}
              value={next}
              autoComplete="new-password"
              onChange={(event) => setNext(event.target.value)}
            />
          )}
        </FormField>
        <FormField label={t('access.changePassword.confirm')}>
          {(id) => (
            <PasswordInput
              id={id}
              value={confirm}
              autoComplete="new-password"
              onChange={(event) => setConfirm(event.target.value)}
            />
          )}
        </FormField>

        {error && <FieldError>{error}</FieldError>}
      </div>
    </Modal>
  );
}
