/**
 * Who is at this panel (docs/ROLES_AND_USERS.md §12).
 *
 * Until this session, an Office Panel authenticated as a *machine* and everyone
 * who walked up to it inherited the panel's role. This screen is what makes the
 * panel ask who is using it, so a lead is raised by a person and the permissions
 * enforced are theirs.
 *
 * It is shown after pairing and before anything else. There is no "continue
 * without signing in" — a panel acting for nobody is exactly the state the
 * per-user model exists to remove.
 */

import { useState, type FormEvent } from 'react';

import { api, type ConnectionInfo, type PanelSession } from '../api';
import {
  Button,
  Card,
  FieldError,
  FormField,
  Input,
  LogoLockup,
  OfflineBanner,
  rem,
  t,
} from '@orderbook/ui';

interface Props {
  connection: ConnectionInfo;
  onSignedIn: (session: PanelSession) => void;
}

export function SignInScreen({ connection, onSignedIn }: Props) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const offline = connection.state !== 'connected';

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const { session } = await api.signIn(username, password);
      onSignedIn(session);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('signin.errorFallback'));
      setPassword('');
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
        <p className="ob-small" style={{ textAlign: 'center' }}>
          {connection.companyName ?? t('signin.subtitleFallback')}
        </p>

        {/*
          Said before the attempt, not after it fails. Offline sign-in only works
          for people who have signed in on this panel before, and discovering that
          through a refusal reads as "my password is wrong".
        */}
        {offline && <OfflineBanner>{t('signin.offlineNotice')}</OfflineBanner>}

        <Card>
          <form
            onSubmit={(event) => void submit(event)}
            style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}
          >
            <FormField label={t('signin.username')}>
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

            <FormField label={t('signin.password')}>
              {(id) => (
                <Input
                  id={id}
                  type="password"
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
              {busy ? t('signin.submitting') : t('signin.submit')}
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
