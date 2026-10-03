/**
 * Ask for the master key and hand back a five-minute token (docs/MASTER_KEY.md).
 *
 * `MasterKeyForm` is the bare field, for the sign-in screen's own flows (setup
 * and recovery), which are whole screens rather than dialogs.
 * `MasterKeyPrompt` wraps it in a dialog for a signed-in Server Master: this is
 * a credential prompt, not a record, so a dialog is right here.
 * `useMasterKeyPrompt` turns that dialog into an awaitable `ask()`.
 *
 * Five wrong keys lock the gate for a minute; the server's 429 says how long,
 * and `apiErrorText` renders it.
 */

import { useCallback, useState, type FormEvent, type ReactNode } from 'react';
import type { MasterKeyUnlock } from '@orderbook/shared';

import { api } from '../api';
import { Button, FieldError, FormField, Modal, apiErrorText, t, PasswordInput } from '@orderbook/ui';

export function MasterKeyForm({
  onUnlocked,
  onCancel,
}: {
  onUnlocked: (unlock: MasterKeyUnlock) => void;
  onCancel?: () => void;
}) {
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const unlock = await api.verifyMasterKey(key);
      setKey('');
      onUnlocked(unlock);
    } catch (caught) {
      setError(apiErrorText(caught, 'error.unauthorized.masterKey'));
      setKey('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}
    >
      <FormField label={t('masterKey.label')} hint={t('masterKey.help')}>
        {(id) => (
          <PasswordInput
            id={id}
            value={key}
            autoFocus
            autoComplete="off"
            onChange={(event) => setKey(event.target.value)}
          />
        )}
      </FormField>
      {error && <FieldError>{error}</FieldError>}
      <div style={{ display: 'flex', gap: 'var(--s-8)', justifyContent: 'flex-end' }}>
        {onCancel && (
          <Button variant="secondary" onClick={onCancel}>
            {t('masterKey.cancel')}
          </Button>
        )}
        <Button type="submit" variant="primary" busy={busy} disabled={!key}>
          {busy ? t('masterKey.verifying') : t('masterKey.verify')}
        </Button>
      </div>
    </form>
  );
}

export function MasterKeyPrompt({
  open,
  onDone,
}: {
  open: boolean;
  /** The token, or null when the person cancelled. */
  onDone: (token: string | null) => void;
}) {
  return (
    <Modal open={open} onClose={() => onDone(null)} size="sm" title={t('masterKey.title')}>
      <MasterKeyForm onUnlocked={(unlock) => onDone(unlock.token)} onCancel={() => onDone(null)} />
    </Modal>
  );
}

/**
 * `const { ask, prompt } = useMasterKeyPrompt()`: render `prompt` once, then
 * `const token = await ask()` before a guarded call. Null means cancelled.
 */
export function useMasterKeyPrompt(): { ask: () => Promise<string | null>; prompt: ReactNode } {
  const [resolve, setResolve] = useState<((token: string | null) => void) | null>(null);

  const ask = useCallback(() => new Promise<string | null>((done) => setResolve(() => done)), []);

  const prompt = (
    <MasterKeyPrompt
      open={resolve !== null}
      onDone={(token) => {
        resolve?.(token);
        setResolve(null);
      }}
    />
  );

  return { ask, prompt };
}
