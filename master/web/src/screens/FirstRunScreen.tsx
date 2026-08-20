/**
 * First screen on a brand-new installation. Generates this Master's identity
 * and shows the credentials — the only time the passwords are ever visible, so
 * the screen insists on an explicit acknowledgement before moving on.
 */

import { useState } from 'react';
import { api, type FirstRunCredentials } from '../api';
import { Field, ReadOnlyField } from '../components/Field';

interface Props {
  onComplete: () => void;
}

export function FirstRunScreen({ onComplete }: Props) {
  const [companyName, setCompanyName] = useState('');
  const [credentials, setCredentials] = useState<FirstRunCredentials | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      setCredentials(await api.initialize(companyName));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Setup failed');
    } finally {
      setBusy(false);
    }
  }

  if (credentials) {
    return (
      <div style={{ maxWidth: 640, margin: '40px auto', padding: '0 16px' }}>
        <h1>Master Panel is ready</h1>
        <div className="notice">
          Write these down now. The two passwords are shown only on this screen and cannot be
          displayed again.
        </div>

        <div className="card">
          <h3 style={{ marginTop: 0 }}>Sign in to this Master Panel</h3>
          <ReadOnlyField label="ID">
            <div className="secret-box">{credentials.username}</div>
          </ReadOnlyField>
          <ReadOnlyField label="Password">
            <div className="secret-box">{credentials.password}</div>
          </ReadOnlyField>
        </div>

        <div className="card">
          <h3 style={{ marginTop: 0 }}>Connecting Office Panels</h3>
          <p className="muted">
            Office Panels normally connect automatically. These details are only needed for manual
            connection, when automatic search is blocked on your network.
          </p>
          <ReadOnlyField label={credentials.lanIps.length > 1 ? 'Master addresses' : 'Master address'}>
            <div className="secret-box">
              {credentials.lanIps.length
                ? credentials.lanIps.map((ip) => `${ip}:${credentials.port}`).join('  •  ')
                : `This PC has no network address yet — port ${credentials.port}`}
            </div>
          </ReadOnlyField>
          <ReadOnlyField label="Master ID">
            <div className="secret-box">{credentials.masterUniqueId}</div>
          </ReadOnlyField>
          <ReadOnlyField label="Pairing password">
            <div className="secret-box">{credentials.pairingPassword}</div>
          </ReadOnlyField>
        </div>

        <button onClick={onComplete}>I have written these down — continue to sign in</button>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 520, margin: '80px auto', padding: '0 16px' }}>
      <h1>Set up this Master Panel</h1>
      <p className="muted">
        This PC will store all data for the software. Run this once, on the computer that stays
        connected to your WiFi router.
      </p>

      {error && <div className="error">{error}</div>}

      <div className="card">
        <Field label="Company name (optional)">
          {(id) => (
            <input
              id={id}
              value={companyName}
              onChange={(event) => setCompanyName(event.target.value)}
              placeholder="e.g. Shree Ceramics"
            />
          )}
        </Field>
        <button onClick={generate} disabled={busy}>
          {busy ? 'Generating…' : 'Generate connection details'}
        </button>
      </div>
    </div>
  );
}
