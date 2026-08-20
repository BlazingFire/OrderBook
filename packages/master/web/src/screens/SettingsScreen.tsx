/**
 * Connection details (re-readable at any time) and storage usage — the two
 * things an operator needs from the Master beyond day-to-day data.
 *
 * The pairing password is deliberately absent: it was shown once at setup and
 * only its hash is stored, so it cannot be displayed again.
 */

import { useEffect, useState } from 'react';
import type { MasterIdentity, StorageUsage } from '@orderbook/shared';

import { api } from '../api';
import { ReadOnlyField } from '../components/Field';
import { formatBytes, formatDateTime } from '../format';

export function SettingsScreen() {
  const [identity, setIdentity] = useState<MasterIdentity | null>(null);
  const [storage, setStorage] = useState<StorageUsage | null>(null);

  useEffect(() => {
    void api.identity().then(setIdentity).catch(() => setIdentity(null));
    void api.storage().then(setStorage).catch(() => setStorage(null));
  }, []);

  return (
    <div>
      <h2>Settings</h2>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Connection details</h3>
        <p className="muted">
          Office Panels normally connect automatically. Use these only for manual connection.
        </p>
        {identity ? (
          <>
            <ReadOnlyField label="Company">
              <div>{identity.companyName ?? '—'}</div>
            </ReadOnlyField>
            <ReadOnlyField label={identity.lanIps.length > 1 ? 'Master addresses' : 'Master address'}>
              <div className="secret-box">
                {identity.lanIps.length
                  ? identity.lanIps.map((ip) => `${ip}:${identity.port}`).join('  •  ')
                  : `No network address detected — port ${identity.port}`}
              </div>
            </ReadOnlyField>
            <ReadOnlyField label="Master ID">
              <div className="secret-box">{identity.masterUniqueId}</div>
            </ReadOnlyField>
            <ReadOnlyField label="Set up on">
              <div>{formatDateTime(identity.setupCompletedAt)}</div>
            </ReadOnlyField>
            <p className="muted">
              The pairing password is not stored in readable form and cannot be shown again. Office
              Panels already connected are unaffected.
            </p>
          </>
        ) : (
          <p className="muted">Loading…</p>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Storage on this PC</h3>
        {storage ? (
          <table>
            <tbody>
              <tr>
                <td>Database</td>
                <td>{formatBytes(storage.databaseBytes)}</td>
              </tr>
              <tr>
                <td>Images and files</td>
                <td>{formatBytes(storage.uploadsBytes)}</td>
              </tr>
              <tr>
                <td>
                  <strong>Total used by this software</strong>
                </td>
                <td>
                  <strong>{formatBytes(storage.totalBytes)}</strong>
                </td>
              </tr>
              <tr>
                <td>Free space on this drive</td>
                <td>{formatBytes(storage.diskFreeBytes)}</td>
              </tr>
            </tbody>
          </table>
        ) : (
          <p className="muted">Loading…</p>
        )}
      </div>
    </div>
  );
}
