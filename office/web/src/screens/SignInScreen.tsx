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
import { Field } from '../components/Field';

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
      setError(caught instanceof Error ? caught.message : 'Sign-in failed');
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 420, margin: '0 auto', padding: '60px 16px' }}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>OrderBook — Office Panel</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        {connection.companyName ?? 'Sign in to continue'}
      </p>

      {/*
        Said before the attempt, not after it fails. Offline sign-in only works
        for people who have signed in on this panel before, and discovering that
        through a refusal reads as "my password is wrong".
      */}
      {offline && (
        <div className="notice" role="status">
          The Master Panel is not reachable right now. You can still sign in if you have used this
          panel before — your work will be saved here and sent when the Master returns.
        </div>
      )}

      <form onSubmit={(event) => void submit(event)} className="card">
        <Field label="Username">
          {(id) => (
            <input
              id={id}
              value={username}
              autoFocus
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              onChange={(event) => setUsername(event.target.value)}
            />
          )}
        </Field>

        <Field label="Password">
          {(id) => (
            <input
              id={id}
              type="password"
              value={password}
              autoComplete="current-password"
              onChange={(event) => setPassword(event.target.value)}
            />
          )}
        </Field>

        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}

        <button type="submit" disabled={busy || !username || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
