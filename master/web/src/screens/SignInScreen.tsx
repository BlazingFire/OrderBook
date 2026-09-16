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
 */

import { useState, type FormEvent } from 'react';
import type { MessageKey, SignedInUser } from '@orderbook/shared';
import { api } from '../api';
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
} from '@orderbook/ui';

interface Props {
  onSignedIn: (user: SignedInUser, sessionToken: string) => void;
  /** Why the window is back here, when it did not get here by signing out. */
  notice?: MessageKey | null;
}

export function SignInScreen({ onSignedIn, notice }: Props) {
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
      setError(apiErrorText(caught, 'signIn.error.default'));
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

        {/* Above the card, not inside it: it explains why this screen is here,
            which is not about the fields below. */}
        {notice && (
          <p className="ob-small" style={{ textAlign: 'center', margin: 0, color: 'var(--accent)' }}>
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
