import { useState, type FormEvent } from 'react';
import type { User } from '@orderbook/shared';
import { api } from '../api';
import { Field } from '../components/Field';

interface Props {
  onSignedIn: (user: User, sessionToken: string) => void;
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
      setError(caught instanceof Error ? caught.message : 'Sign in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 400, margin: '100px auto', padding: '0 16px' }}>
      <h1>Master Panel</h1>
      <p className="muted">Enter the ID and password generated during setup.</p>

      {error && <div className="error">{error}</div>}

      <form className="card" onSubmit={submit}>
        <Field label="ID">
          {(id) => (
            <input
              id={id}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoFocus
            />
          )}
        </Field>
        <Field label="Password">
          {(id) => (
            <input
              id={id}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          )}
        </Field>
        <button type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
