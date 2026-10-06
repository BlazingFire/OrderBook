/**
 * Sign in to the Master.
 *
 * Two things this screen used to get wrong, both fixed here:
 *
 *  · It rendered `caught.message` — the server's **English** sentence — and
 *    discarded the `messageKey` the transport carries, so every sign-in failure
 *    used the server's wording. `apiErrorText` is the client the
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

import { useRef, useState, type FormEvent } from 'react';
import type { MessageKey, SignedInUser } from '@orderbook/shared';
import { api } from '../api';
import { MasterKeyRecoveryFlow } from './MasterKeyRecoveryFlow';
import { ServerMasterSetupFlow } from './ServerMasterSetupFlow';
import {
  Button,
  CapsLockHint,
  Card,
  DeviceWarning,
  FieldError,
  FormField,
  Input,
  LogoLockup,
  apiErrorText,
  rem,
  t,
  PasswordInput,
  useCapsLock,
  useDeviceInfo,
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
  const passwordRef = useRef<HTMLInputElement>(null);
  const caps = useCapsLock();
  // On the Master PC this browser and the Master share a machine, so the Master's figures are this PC's.
  // A LAN browser would be shown the Master's hardware as its own, so it is not asked.
  const device = useDeviceInfo(onMasterPc ? api.device : () => Promise.reject(new Error('not the Master PC')));

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
      // Back in the password box, empty: the next thing to do is type it again.
      window.setTimeout(() => passwordRef.current?.focus(), 0);
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
        // Less air above on a short window: at 1280x720 and 157 % the fixed 56
        // made the page 5 px taller than the window, so it scrolled.
        padding: 'clamp(var(--s-24), 8vh, var(--s-56)) var(--s-16)',
      }}
    >
      <LogoLockup markSize={28} />

      <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
        <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
          <h1 className="ob-title" style={{ margin: 0 }}>
            {t('signIn.action.signIn')}
          </h1>
          <p className="ob-small" style={{ margin: 0 }}>
            {t('signIn.subtitle')}
          </p>
        </div>

        {/* Above the card, not inside it: it explains why this screen is here,
            which is not about the fields below. */}
        {notice && (
          <div className="ob-banner" role="status">
            <span>{t(notice)}</span>
          </div>
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
                  ref={passwordRef}
                  value={password}
                  autoComplete="current-password"
                  onChange={(event) => setPassword(event.target.value)}
                  {...caps.handlers}
                />
              )}
            </FormField>
            <CapsLockHint on={caps.on} />

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

        {/* Said before signing in, not after it feels slow: this PC is short of memory or cores. */}
        <DeviceWarning device={device} />
      </div>
    </div>
  );
}
