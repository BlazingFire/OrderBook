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
import {
  Button,
  Card,
  Checkbox,
  ConflictBanner,
  EmptyState,
  formatDateTime,
  t,
} from '@orderbook/ui';

interface Props {
  revision: number;
  canResolve: boolean;
}

type ConflictAction = 'keepWinner' | 'restoreLoser';

export function ConflictsScreen({ revision, canResolve }: Props) {
  const [conflicts, setConflicts] = useState<SyncConflict[]>([]);
  const [showResolved, setShowResolved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<{ id: number; action: ConflictAction } | null>(null);

  const load = useCallback(async () => {
    try {
      setConflicts(await api.conflicts(showResolved));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('conflicts.error.load'));
    }
  }, [showResolved]);

  useEffect(() => {
    void load();
  }, [load, revision]);

  async function resolve(conflict: SyncConflict, action: ConflictAction): Promise<void> {
    setBusy({ id: conflict.id, action });
    setError(null);
    try {
      await api.resolveConflict(conflict.id, action);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('conflicts.error.resolve'));
    } finally {
      setBusy(null);
    }
  }

  const visible = showResolved ? conflicts : conflicts.filter((conflict) => !conflict.resolvedAt);

  return (
    <div
      className="ob-measure-wide"
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <p className="ob-small" style={{ margin: 0 }}>
          {t('conflicts.description')}
        </p>
        <Checkbox
          checked={showResolved}
          onChange={setShowResolved}
          label={t('conflicts.includeReviewed')}
        />
      </div>

      {!canResolve && (
        <p className="ob-small" style={{ margin: 0, color: 'var(--fg-tertiary)' }}>
          {t('conflicts.noPermission', { permission: 'sync.resolveConflicts' })}
        </p>
      )}

      {error && <ConflictBanner>{error}</ConflictBanner>}

      {visible.length === 0 ? (
        <Card>
          <EmptyState
            title={t('conflicts.empty.title')}
            description={t('conflicts.empty.description')}
          />
        </Card>
      ) : (
        visible.map((conflict) => (
          <Card key={conflict.id}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <h2 className="ob-title" style={{ margin: 0 }}>
                {conflict.entity} {conflict.entityId} —{' '}
                <code className="ob-mono">{conflict.field}</code>
              </h2>
              <span className="ob-small">{formatDateTime(conflict.createdAt)}</span>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: 'var(--s-12)',
                marginTop: 'var(--s-12)',
              }}
            >
              <ConflictValue
                label={t('conflicts.kept', { device: conflict.winningDeviceCode })}
                value={conflict.winningValue}
              />
              <ConflictValue
                label={t('conflicts.overwritten', { device: conflict.losingDeviceCode })}
                value={conflict.losingValue}
              />
            </div>

            {conflict.resolvedAt ? (
              <p className="ob-small" style={{ marginBottom: 0, marginTop: 'var(--s-12)' }}>
                {t('conflicts.reviewedAt', { when: formatDateTime(conflict.resolvedAt) })}
              </p>
            ) : (
              <div style={{ display: 'flex', gap: 'var(--s-8)', marginTop: 'var(--s-12)' }}>
                <Button
                  variant="secondary"
                  busy={busy?.id === conflict.id && busy.action === 'keepWinner'}
                  disabled={!canResolve || (busy !== null && busy.id !== conflict.id)}
                  onClick={() => void resolve(conflict, 'keepWinner')}
                >
                  {t('conflicts.action.keepWinner')}
                </Button>
                <Button
                  variant="primary"
                  busy={busy?.id === conflict.id && busy.action === 'restoreLoser'}
                  disabled={!canResolve || (busy !== null && busy.id !== conflict.id)}
                  onClick={() => void resolve(conflict, 'restoreLoser')}
                >
                  {t('conflicts.action.restoreLoser')}
                </Button>
              </div>
            )}
          </Card>
        ))
      )}
    </div>
  );
}

function ConflictValue({ label, value }: { label: string; value: unknown }) {
  return (
    <div
      style={{
        background: 'var(--bg-sunken)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--r-md)',
        padding: 'var(--s-12)',
      }}
    >
      <div className="ob-small">{label}</div>
      <pre
        className="ob-data"
        style={{ margin: 'var(--s-6) 0 0', whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}
      >
        {stringify(value)}
      </pre>
    </div>
  );
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return t('conflicts.emptyValue');
  if (typeof value === 'string') return value || t('conflicts.emptyValue');
  return JSON.stringify(value, null, 2);
}
