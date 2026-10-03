/**
 * "Forgot Server Master password?" on the Master PC sign-in screen.
 *
 * The master key, then the Server Master, then a new password. Only the
 * password changes, never the username. The server also lifts that username's
 * sign-in lockout and ends its sessions, so the new password works at once.
 * Offered only on the Master PC: every route behind it is loopback-only.
 */

import { useState } from 'react';
import type { ServerMasterAccount } from '@orderbook/shared';

import { api } from '../api';
import { MasterKeyForm } from '../components/MasterKeyPrompt';
import {
  Button,
  Card,
  EmptyState,
  FieldError,
  FormField,
  LogoLockup,
  Select,
  apiErrorText,
  rem,
  t,
  PasswordInput,
} from '@orderbook/ui';

/** The server's own floor (`validation.password.tooShort`), checked here too. */
const MIN_PASSWORD_LENGTH = 8;

type Step = 'key' | 'reset' | 'done';

export function MasterKeyRecoveryFlow({ onBack }: { onBack: () => void }) {
  const [step, setStep] = useState<Step>('key');
  const [token, setToken] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<ServerMasterAccount[]>([]);
  const [userId, setUserId] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function unlocked(nextToken: string): Promise<void> {
    setError(null);
    try {
      const list = await api.serverMasters(nextToken);
      setAccounts(list.accounts);
      setUserId(list.accounts[0]?.id ?? '');
      setToken(nextToken);
      setStep('reset');
    } catch (caught) {
      setError(apiErrorText(caught, 'error.requestFailed'));
    }
  }

  async function reset(): Promise<void> {
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(t('validation.password.tooShort'));
      return;
    }
    if (password !== confirm) {
      setError(t('firstRun.serverMaster.passwordMismatch'));
      return;
    }
    if (!token || !userId) return;
    setBusy(true);
    setError(null);
    try {
      await api.recoverServerMaster(userId, password, token);
      setPassword('');
      setConfirm('');
      setStep('done');
    } catch (caught) {
      if (
        (caught as { messageKey?: string }).messageKey === 'error.unauthorized.masterKeyRequired'
      ) {
        setToken(null);
        setStep('key');
      }
      setError(apiErrorText(caught, 'error.requestFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 'var(--s-24)',
        maxWidth: rem(420),
        margin: '0 auto',
        padding: 'var(--s-56) var(--s-16)',
      }}
    >
      <LogoLockup markSize={28} />

      <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
        <h1 className="ob-title" style={{ margin: 0, textAlign: 'center' }}>
          {t('masterKey.recover.title')}
        </h1>

        <Card>
          {step === 'key' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
              {error && <FieldError>{error}</FieldError>}
              <MasterKeyForm
                onUnlocked={(unlock) => void unlocked(unlock.token)}
                onCancel={onBack}
              />
            </div>
          )}

          {step === 'reset' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
              <FormField label={t('masterKey.recover.account')}>
                {(id) => (
                  <Select
                    id={id}
                    value={userId}
                    onChange={(event) => setUserId(event.target.value)}
                  >
                    {accounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {`${account.displayName} (${account.username})`}
                      </option>
                    ))}
                  </Select>
                )}
              </FormField>
              <FormField label={t('masterKey.recover.newPassword')}>
                {(id) => (
                  <PasswordInput
                    id={id}
                    value={password}
                    autoComplete="new-password"
                    onChange={(event) => setPassword(event.target.value)}
                  />
                )}
              </FormField>
              <FormField label={t('masterKey.recover.confirmPassword')}>
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
              <div style={{ display: 'flex', gap: 'var(--s-8)', justifyContent: 'flex-end' }}>
                <Button variant="secondary" onClick={onBack}>
                  {t('masterKey.cancel')}
                </Button>
                <Button
                  variant="primary"
                  busy={busy}
                  disabled={!userId || !password || !confirm}
                  onClick={() => void reset()}
                >
                  {t('masterKey.recover.submit')}
                </Button>
              </div>
            </div>
          )}

          {step === 'done' && (
            <EmptyState
              title={t('masterKey.recover.done')}
              actionLabel={t('signIn.action.signIn')}
              onAction={onBack}
            />
          )}
        </Card>
      </div>
    </div>
  );
}
