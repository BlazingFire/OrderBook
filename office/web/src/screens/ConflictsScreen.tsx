/**
 * Conflicts left by the field-level merge (docs/LEAD_GENERATION_FLOW.md §4.5).
 *
 * The merge already chose what the record holds; nothing here is urgent. What
 * this screen exists for is the case the merge cannot judge — where the value
 * that lost happened to be the right one. Both values are shown side by side,
 * with who wrote each, and restoring is a deliberate click.
 */

import { useState } from 'react';
import type { SyncConflict } from '@orderbook/shared';

import { api } from '../api';
import { formatDateTime } from '../format';

interface Props {
  conflicts: SyncConflict[];
  canResolve: boolean;
  onError: (message: string) => void;
  onResolved: () => void;
}

export function ConflictsScreen({ conflicts, canResolve, onError, onResolved }: Props) {
  const [busyId, setBusyId] = useState<number | null>(null);

  const open = conflicts.filter((conflict) => !conflict.resolvedAt);

  if (open.length === 0) {
    return (
      <div className="card">
        <p className="muted">
          Nothing to review. Conflicts appear here when two panels edit the same field of the same
          record while both are offline.
        </p>
      </div>
    );
  }

  async function resolve(
    conflict: SyncConflict,
    action: 'keepWinner' | 'restoreLoser',
  ): Promise<void> {
    setBusyId(conflict.id);
    try {
      await api.resolveConflict(conflict.id, action);
      onResolved();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : 'Could not resolve the conflict');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="stack">
      {open.map((conflict) => (
        <div className="card" key={conflict.id}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h3 className="section-title" style={{ marginBottom: 0 }}>
              {conflict.entity} {conflict.entityId} — <code>{conflict.field}</code>
            </h3>
            <span className="muted">{formatDateTime(conflict.createdAt)}</span>
          </div>

          <div className="split" style={{ marginTop: 12 }}>
            <div className="line-card" style={{ marginBottom: 0 }}>
              <div className="muted">Kept (device {conflict.winningDeviceCode})</div>
              <pre style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>
                {stringify(conflict.winningValue)}
              </pre>
            </div>

            <div className="line-card" style={{ marginBottom: 0 }}>
              <div className="muted">Overwritten (device {conflict.losingDeviceCode})</div>
              <pre style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>
                {stringify(conflict.losingValue)}
              </pre>
            </div>
          </div>

          <div className="row" style={{ gap: 8, marginTop: 12 }}>
            <button
              className="secondary"
              disabled={busyId === conflict.id || !canResolve}
              onClick={() => void resolve(conflict, 'keepWinner')}
            >
              Keep what is there
            </button>
            <button
              disabled={busyId === conflict.id || !canResolve}
              onClick={() => void resolve(conflict, 'restoreLoser')}
            >
              Put the other value back
            </button>
          </div>

          {!canResolve && (
            <p className="muted" style={{ marginBottom: 0, marginTop: 8 }}>
              Your role does not include <code>sync.resolveConflicts</code>.
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '(empty)';
  if (typeof value === 'string') return value || '(empty)';
  return JSON.stringify(value, null, 2);
}
