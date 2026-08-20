/**
 * The Office Panel's first screen. Shows whether this PC is on the network at
 * all, then offers the two ways to reach a Master.
 *
 * Auto connection is presented first and recommended; manual exists for
 * networks where broadcast traffic is blocked.
 */

import { useState, type FormEvent } from 'react';

import { api, type ConnectionInfo, type DiscoveredMaster } from '../api';
import { Field } from '../components/Field';

interface Props {
  connection: ConnectionInfo;
  onConnected: () => void;
}

export function ConnectionScreen({ connection, onConnected }: Props) {
  const [mode, setMode] = useState<'auto' | 'manual'>('auto');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<DiscoveredMaster[] | null>(null);

  const [host, setHost] = useState('');
  const [port, setPort] = useState('4100');
  const [pairingPassword, setPairingPassword] = useState('');
  const [panelName, setPanelName] = useState(connection.panelName);

  async function connectAutomatically() {
    setBusy(true);
    setError(null);
    try {
      await api.pairAuto(panelName);
      onConnected();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Connection failed');
    } finally {
      setBusy(false);
    }
  }

  async function scan() {
    setBusy(true);
    setError(null);
    setFound(null);
    try {
      const result = await api.scan();
      setFound(result.masters);
      // Prefill the manual form from whatever answered, so the operator rarely
      // has to type an address even when using manual mode.
      const first = result.masters[0];
      if (first) {
        setHost(first.lanIp);
        setPort(String(first.httpPort));
      }
    } catch {
      setError('Could not search the network');
    } finally {
      setBusy(false);
    }
  }

  async function connectManually(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.pairManual({
        host: host.trim(),
        port: Number(port) || 4100,
        pairingPassword: pairingPassword.trim(),
        panelName,
      });
      onConnected();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Connection failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 620, margin: '40px auto', padding: '0 16px' }}>
      <h1>Connect to Master Panel</h1>

      <div className="card">
        <div className="row">
          <span className={`dot ${connection.hasNetworkLink ? 'on' : 'off'}`} />
          <strong>
            {connection.hasNetworkLink ? 'Connected to network' : 'Not connected to any network'}
          </strong>
        </div>
        {connection.hasNetworkLink ? (
          <div className="muted" style={{ marginTop: 6 }}>
            This PC: {connection.interfaces.map((entry) => entry.address).join(', ')}
          </div>
        ) : (
          <div className="muted" style={{ marginTop: 6 }}>
            Plug in the LAN cable or join the shop WiFi, then this screen will update.
          </div>
        )}
      </div>

      {error && <div className="error">{error}</div>}

      <div className="row" style={{ marginBottom: 12 }}>
        <button className={mode === 'auto' ? '' : 'secondary'} onClick={() => setMode('auto')}>
          Auto connection
        </button>
        <button className={mode === 'manual' ? '' : 'secondary'} onClick={() => setMode('manual')}>
          Manual connection
        </button>
      </div>

      {mode === 'auto' ? (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Auto connection (recommended)</h3>
          <ol className="muted" style={{ paddingLeft: 18, marginTop: 0 }}>
            <li>On the Master Panel PC, open “Office Panels” and press “Add Office Panel”.</li>
            <li>It will say “Waiting for office panel…”.</li>
            <li>Press the button below. The two will find each other automatically.</li>
          </ol>

          <Field label="Name for this PC">
            {(id) => (
              <input id={id} value={panelName} onChange={(event) => setPanelName(event.target.value)} />
            )}
          </Field>

          <div className="row">
            <button onClick={connectAutomatically} disabled={busy || !connection.hasNetworkLink}>
              {busy ? 'Searching…' : 'Proceed with Auto Connection'}
            </button>
            <button className="secondary" onClick={scan} disabled={busy}>
              Search only
            </button>
          </div>

          {found && (
            <div style={{ marginTop: 12 }}>
              {found.length === 0 ? (
                <div className="muted">
                  No Master Panel answered. Check that the Master PC is switched on and on the same
                  network.
                </div>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Master</th>
                      <th>Address</th>
                      <th>Accepting</th>
                    </tr>
                  </thead>
                  <tbody>
                    {found.map((master) => (
                      <tr key={master.masterUniqueId}>
                        <td>{master.companyName ?? 'Master Panel'}</td>
                        <td>
                          {master.lanIp}:{master.httpPort}
                        </td>
                        <td>{master.acceptingPairing ? 'Yes' : 'Not right now'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      ) : (
        <form className="card" onSubmit={connectManually}>
          <h3 style={{ marginTop: 0 }}>Manual connection</h3>
          <p className="muted">
            Use the address and pairing password shown on the Master Panel’s setup screen.
          </p>

          <div className="grid cols-2">
            <Field label="Master address">
              {(id) => (
                <input
                  id={id}
                  value={host}
                  onChange={(event) => setHost(event.target.value)}
                  placeholder="192.168.1.10"
                  required
                />
              )}
            </Field>
            <Field label="Port">
              {(id) => <input id={id} value={port} onChange={(event) => setPort(event.target.value)} />}
            </Field>
          </div>

          <Field label="Pairing password">
            {(id) => (
              <input
                id={id}
                value={pairingPassword}
                onChange={(event) => setPairingPassword(event.target.value)}
                required
              />
            )}
          </Field>

          <Field label="Name for this PC">
            {(id) => (
              <input id={id} value={panelName} onChange={(event) => setPanelName(event.target.value)} />
            )}
          </Field>

          <button type="submit" disabled={busy}>
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        </form>
      )}
    </div>
  );
}
