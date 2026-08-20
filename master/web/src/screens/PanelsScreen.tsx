/**
 * Connected Office Panels, plus the "Add Office Panel" flow.
 *
 * Opening this screen's pairing window is what allows a panel to join, so the
 * waiting state is explicit and closes itself when the operator leaves.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { OfficePanelWithPresence } from '@orderbook/shared';

import { api } from '../api';
import { formatDateTime } from '../format';

interface Props {
  panels: OfficePanelWithPresence[];
  onRefresh: () => void;
}

export function PanelsScreen({ panels, onRefresh }: Props) {
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previousPanelCount = useRef(panels.length);

  const stopWaiting = useCallback(async () => {
    setWaiting(false);
    await api.closePairingWindow().catch(() => {});
  }, []);

  // A panel appearing while we wait is the success signal — the list is pushed
  // live over the socket, so no polling is needed here.
  useEffect(() => {
    if (waiting && panels.length > previousPanelCount.current) void stopWaiting();
    previousPanelCount.current = panels.length;
  }, [panels.length, waiting, stopWaiting]);

  // Leaving this screen must not leave the network open to new panels.
  useEffect(() => {
    return () => {
      void api.closePairingWindow().catch(() => {});
    };
  }, []);

  async function startWaiting() {
    setError(null);
    try {
      await api.openPairingWindow();
      setWaiting(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not start pairing');
    }
  }

  async function revoke(panel: OfficePanelWithPresence) {
    if (!confirm(`Remove "${panel.name}"? That PC will have to connect again.`)) return;
    await api.revokePanel(panel.id);
    onRefresh();
  }

  async function rename(panel: OfficePanelWithPresence) {
    const name = prompt('Name for this office panel', panel.name);
    if (!name) return;
    await api.renamePanel(panel.id, name);
    onRefresh();
  }

  return (
    <div>
      <h2>Office Panels</h2>
      {error && <div className="error">{error}</div>}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Add Office Panel</h3>
        {waiting ? (
          <>
            <div className="notice">
              <strong>Waiting for office panel…</strong>
              <div className="muted" style={{ marginTop: 4 }}>
                On the office PC, open the Office Panel and press “Proceed with Auto Connection”.
                It will find this Master automatically.
              </div>
            </div>
            <button className="secondary" onClick={stopWaiting}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <p className="muted">
              Press this, then start automatic connection on the office PC. This Master only accepts
              new panels while you are waiting here.
            </p>
            <button onClick={startWaiting}>Add Office Panel</button>
          </>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Connected Office Panels</h3>
        {panels.length === 0 ? (
          <p className="muted">No office panels have been connected yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Status</th>
                <th>Name</th>
                <th>Address</th>
                <th>Paired</th>
                <th>Last seen</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {panels.map((panel) => (
                <tr key={panel.id}>
                  <td>
                    <span className={`dot ${panel.isConnected ? 'on' : 'off'}`} />
                    {panel.status === 'revoked'
                      ? 'Removed'
                      : panel.isConnected
                        ? 'Connected'
                        : 'Offline'}
                  </td>
                  <td>{panel.name}</td>
                  <td>{panel.lanIp ?? '—'}</td>
                  <td>{formatDateTime(panel.pairedAt)}</td>
                  <td>{formatDateTime(panel.lastSeenAt)}</td>
                  <td>
                    {panel.status !== 'revoked' && (
                      <div className="row">
                        <button className="secondary" onClick={() => rename(panel)}>
                          Rename
                        </button>
                        <button className="danger" onClick={() => revoke(panel)}>
                          Remove
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
