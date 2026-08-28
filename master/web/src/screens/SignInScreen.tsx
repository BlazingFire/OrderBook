import { useState, type FormEvent } from 'react';
import type { SignedInUser } from '@orderbook/shared';
import { api } from '../api';
import { Button, Card, FieldError, FormField, Input, LogoLockup, rem, t } from '@orderbook/ui';

interface Props {
  onSignedIn: (user: SignedInUser, sessionToken: string) => void;
}

export function SignInScreen({ onSignedIn }: Props) {
  const [username, setUsername] = useState('admin');
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
      setError(caught instanceof Error ? caught.message : t('signIn.error.default'));
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
        <p className="ob-small" style={{ textAlign: 'center', margin: 0 }}>
          {t('signIn.subtitle')}
        </p>

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
              {busy ? t('signIn.action.signingIn') : t('signIn.action.signIn')}
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
