/**
 * Sign in to the Master.
 *
 * Two things this screen used to get wrong, both fixed here:
 *
 *  · It rendered `caught.message` — the server's **English** sentence — and
 *    discarded the `messageKey` the transport carries, so every sign-in failure
 *    was in English on a Hindi panel. `apiErrorText` is the client the
 *    three-tier pipeline never had.
 *  · There was no way to say why the window arrived back here. A session that
 *    ends mid-use (most often: this person just changed their own password,
 *    which invalidates every session they hold) dropped them to a bare sign-in
 *    form with no explanation.
 *
 * On the Master PC it is also the door to the master-key flows: an
 * installation that still owes its owner two Server Master accounts shows
 * that setup first (no skip), and "Forgot Server Master password?" opens the
 * recovery flow. Neither is offered to a LAN browser. There is no username
 * prefill: a fresh setup has no `admin` account to suggest.
 */

import { useState, type FormEvent } from 'react';
import type { MessageKey, SignedInUser } from '@orderbook/shared';
import { api } from '../api';
import { MasterKeyRecoveryFlow } from './MasterKeyRecoveryFlow';
import { ServerMasterSetupFlow } from './ServerMasterSetupFlow';
import {
  Button,
  Card,
  FieldError,
  FormField,
  Input,
  LogoLockup,
  apiErrorText,
  rem,
  t,
  PasswordInput,
} from '@orderbook/ui';

interface Props {
  onSignedIn: (user: SignedInUser, sessionToken: string) => void;
  /** Why the window is back here, when it did not get here by signing out. */
  notice?: MessageKey | null;
  /** This browser is on the Master PC, where the master-key flows are offered. */
  onMasterPc?: boolean;
  /** Fewer than two Server Masters exist: on the Master PC, set them up first. */
  serverMasterSetupNeeded?: boolean;
  /** The setup flow finished; the caller stops asking for it. */
  onServerMastersSetUp?: () => void;
}

export function SignInScreen({
  onSignedIn,
  notice,
  onMasterPc = false,
  serverMasterSetupNeeded = false,
  onServerMastersSetUp,
}: Props) {
  const [recovering, setRecovering] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.signIn(username, password);
      onSignedIn(result.user, result.sessionToken);
    } catch (caught) {
      setError(apiErrorText(caught, 'signIn.error.default'));
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  if (onMasterPc && serverMasterSetupNeeded) {
    return <ServerMasterSetupFlow onDone={() => onServerMastersSetUp?.()} />;
  }

  if (onMasterPc && recovering) {
    return <MasterKeyRecoveryFlow onBack={() => setRecovering(false)} />;
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
        <p className="ob-small" style={{ textAlign: 'center', margin: 0 }}>
          {t('signIn.subtitle')}
        </p>

        {/* Above the card, not inside it: it explains why this screen is here,
            which is not about the fields below. */}
        {notice && (
          <p
            className="ob-small"
            style={{ textAlign: 'center', margin: 0, color: 'var(--accent)' }}
          >
            {t(notice)}
          </p>
        )}

        <Card>
          <form
            onSubmit={submit}
            style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}
          >
            <FormField label={t('signIn.field.username')}>
              {(id) => (
                <Input
                  id={id}
                  value={username}
                  autoFocus
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  onChange={(event) => setUsername(event.target.value)}
                />
              )}
            </FormField>
            <FormField label={t('signIn.field.password')}>
              {(id) => (
                <PasswordInput
                  id={id}
                  value={password}
                  autoComplete="current-password"
                  onChange={(event) => setPassword(event.target.value)}
                />
              )}
            </FormField>

            {/* Stays visible until the next attempt — a failed sign-in must not
                vanish the way a toast would after a few seconds. */}
            {error && <FieldError>{error}</FieldError>}

            <Button type="submit" variant="primary" busy={busy} disabled={!username || !password}>
              {busy ? t('signIn.action.signingIn') : t('signIn.action.signIn')}
            </Button>

            {onMasterPc && (
              <Button variant="ghost" size="sm" onClick={() => setRecovering(true)}>
                {t('masterKey.recover.link')}
              </Button>
            )}
          </form>
        </Card>
      </div>
    </div>
  );
}
