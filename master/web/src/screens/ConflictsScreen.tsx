/**
 * Sync conflicts on the Master (docs/LEAD_GENERATION_FLOW.md §4.5).
 *
 * The merge already decided what each record holds — nothing here is broken and
 * nothing is urgent. This screen exists for the one judgement the merge cannot
 * make: whether the value that lost happened to be the right one.
 */

import { useCallback, useEffect, useState } from 'react';
import type { SyncConflict } from '@orderbook/shared';

import { api } from '../api';
import { formatDateTime } from '../format';

interface Props {
  revision: number;
}

export function ConflictsScreen({ revision }: Props) {
  const [conflicts, setConflicts] = useState<SyncConflict[]>([]);
  const [showResolved, setShowResolved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setConflicts(await api.conflicts(showResolved));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load conflicts');
    }
  }, [showResolved]);

  useEffect(() => {
    void load();
  }, [load, revision]);

  async function resolve(
    conflict: SyncConflict,
    action: 'keepWinner' | 'restoreLoser',
  ): Promise<void> {
    setBusyId(conflict.id);
    setError(null);
    try {
      await api.resolveConflict(conflict.id, action);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not resolve the conflict');
    } finally {
      setBusyId(null);
    }
  }

  const visible = showResolved ? conflicts : conflicts.filter((conflict) => !conflict.resolvedAt);

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ marginBottom: 0 }}>Sync conflicts</h2>
        <label className="row" style={{ gap: 6, marginBottom: 0, cursor: 'pointer' }}>
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            checked={showResolved}
            onChange={(event) => setShowResolved(event.target.checked)}
          />
          Include reviewed
        </label>
      </div>

      <p className="muted">
        Raised when two panels edited the same field of the same record while both were offline. The
        higher timestamp won; the other value is kept here so nothing is lost silently.
      </p>

      {error && <div className="error">{error}</div>}

      {visible.length === 0 ? (
        <div className="card">
          <p className="muted">Nothing to review.</p>
        </div>
      ) : (
        visible.map((conflict) => (
          <div className="card" key={conflict.id}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h3 style={{ margin: 0 }}>
                {conflict.entity} {conflict.entityId} — <code>{conflict.field}</code>
              </h3>
              <span className="muted">{formatDateTime(conflict.createdAt)}</span>
            </div>

            <div className="grid cols-2" style={{ marginTop: 12 }}>
              <div className="line-card" style={{ marginBottom: 0 }}>
                <div className="muted">Kept — from device {conflict.winningDeviceCode}</div>
                <pre style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>
                  {stringify(conflict.winningValue)}
                </pre>
              </div>
              <div className="line-card" style={{ marginBottom: 0 }}>
                <div className="muted">Overwritten — from device {conflict.losingDeviceCode}</div>
                <pre style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>
                  {stringify(conflict.losingValue)}
                </pre>
              </div>
            </div>

            {conflict.resolvedAt ? (
              <p className="muted" style={{ marginBottom: 0, marginTop: 12 }}>
                Reviewed {formatDateTime(conflict.resolvedAt)}
              </p>
            ) : (
              <div className="row" style={{ gap: 8, marginTop: 12 }}>
                <button
                  className="secondary"
                  disabled={busyId === conflict.id}
                  onClick={() => void resolve(conflict, 'keepWinner')}
                >
                  Keep what is there
                </button>
                <button
                  disabled={busyId === conflict.id}
                  onClick={() => void resolve(conflict, 'restoreLoser')}
                >
                  Put the other value back
                </button>
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '(empty)';
  if (typeof value === 'string') return value || '(empty)';
  return JSON.stringify(value, null, 2);
}
