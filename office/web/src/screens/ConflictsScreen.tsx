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
import { Button, Card, EmptyState, formatDateTime, t } from '@orderbook/ui';

interface Props {
  conflicts: SyncConflict[];
  canResolve: boolean;
  onError: (message: string) => void;
  onResolved: () => void;
}

type ConflictAction = 'keepWinner' | 'restoreLoser';

export function ConflictsScreen({ conflicts, canResolve, onError, onResolved }: Props) {
  const [busy, setBusy] = useState<{ id: number; action: ConflictAction } | null>(null);

  const open = conflicts.filter((conflict) => !conflict.resolvedAt);

  if (open.length === 0) {
    return (
      <EmptyState
        title={t('conflicts.empty.title')}
        description={t('conflicts.empty.description')}
      />
    );
  }

  async function resolve(conflict: SyncConflict, action: ConflictAction): Promise<void> {
    setBusy({ id: conflict.id, action });
    try {
      await api.resolveConflict(conflict.id, action);
      onResolved();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : t('conflicts.resolveErrorFallback'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      className="ob-measure-wide"
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}
    >
      {open.map((conflict) => {
        const rowBusy = busy?.id === conflict.id;
        return (
          <Card key={conflict.id}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
                gap: 'var(--s-12)',
              }}
            >
              <h3 className="ob-title" style={{ margin: 0 }}>
                {conflict.entity} {conflict.entityId} —{' '}
                <span className="ob-mono">{conflict.field}</span>
              </h3>
              <span className="ob-small" style={{ whiteSpace: 'nowrap' }}>
                {formatDateTime(conflict.createdAt)}
              </span>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: 'var(--s-16)',
                marginTop: 'var(--s-12)',
              }}
            >
              <div
                style={{
                  background: 'var(--bg-sunken)',
                  border: '1px solid var(--line)',
                  borderRadius: 'var(--r-md)',
                  padding: 'var(--s-12)',
                }}
              >
                <div className="ob-small">
                  {t('conflicts.kept', { device: conflict.winningDeviceCode })}
                </div>
                <pre
                  className="ob-data"
                  style={{
                    margin: 'var(--s-6) 0 0',
                    whiteSpace: 'pre-wrap',
                    fontFamily: 'inherit',
                  }}
                >
                  {stringify(conflict.winningValue)}
                </pre>
              </div>

              <div
                style={{
                  background: 'var(--bg-sunken)',
                  border: '1px solid var(--line)',
                  borderRadius: 'var(--r-md)',
                  padding: 'var(--s-12)',
                }}
              >
                <div className="ob-small">
                  {t('conflicts.overwritten', { device: conflict.losingDeviceCode })}
                </div>
                <pre
                  className="ob-data"
                  style={{
                    margin: 'var(--s-6) 0 0',
                    whiteSpace: 'pre-wrap',
                    fontFamily: 'inherit',
                  }}
                >
                  {stringify(conflict.losingValue)}
                </pre>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 'var(--s-8)', marginTop: 'var(--s-12)' }}>
              <Button
                variant="secondary"
                disabled={rowBusy || !canResolve}
                busy={busy?.id === conflict.id && busy.action === 'keepWinner'}
                onClick={() => void resolve(conflict, 'keepWinner')}
              >
                {t('conflicts.action.keepWinner')}
              </Button>
              <Button
                variant="primary"
                disabled={rowBusy || !canResolve}
                busy={busy?.id === conflict.id && busy.action === 'restoreLoser'}
                onClick={() => void resolve(conflict, 'restoreLoser')}
              >
                {t('conflicts.action.restoreLoser')}
              </Button>
            </div>

            {!canResolve && (
              <p className="ob-small" style={{ marginTop: 'var(--s-8)', marginBottom: 0 }}>
                {t('conflicts.noPermission', { permission: 'sync.resolveConflicts' })}
              </p>
            )}
          </Card>
        );
      })}
    </div>
  );
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return t('conflicts.empty.value');
  if (typeof value === 'string') return value || t('conflicts.empty.value');
  return JSON.stringify(value, null, 2);
}
