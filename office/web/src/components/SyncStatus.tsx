/**
 * The sync bar (docs/LEAD_GENERATION_FLOW.md §2, §4).
 *
 * Working offline is normal here, not an error state — so this bar reports
 * rather than warns. What it must never do is imply that queued work is lost:
 * the count is always visible, and anything the Master actually refused is
 * shown in full, because a refused mutation is the one case where a person has
 * to do something.
 */

import type { MutationResult } from '@orderbook/shared';

import type { ConnectionInfo } from '../api';

interface Props {
  connection: ConnectionInfo;
  pendingCount: number;
  rejections: MutationResult[];
  onFlush: () => void;
  busy: boolean;
}

export function SyncStatus({ connection, pendingCount, rejections, onFlush, busy }: Props) {
  const online = connection.state === 'connected';

  return (
    <>
      <div className={`sync-bar${online ? '' : ' offline'}`}>
        <span className={`dot ${online ? 'on' : 'off'}`} />
        <span>
          {online
            ? `Connected to the Master Panel${connection.masterHost ? ` (${connection.masterHost})` : ''}`
            : connection.state === 'connecting'
              ? 'Connecting to the Master Panel…'
              : 'Working offline — everything still saves here'}
        </span>

        <span className="spacer" />

        {pendingCount > 0 ? (
          <span className="chip pending">
            {pendingCount} change{pendingCount === 1 ? '' : 's'} waiting to sync
          </span>
        ) : (
          <span className="muted">All changes synced</span>
        )}

        {pendingCount > 0 && online && (
          <button className="secondary" onClick={onFlush} disabled={busy}>
            {busy ? 'Syncing…' : 'Sync now'}
          </button>
        )}
      </div>

      {rejections.length > 0 && (
        <div className="error">
          <strong>
            The Master Panel refused {rejections.length} change
            {rejections.length === 1 ? '' : 's'}:
          </strong>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {rejections.map((rejection) => (
              <li key={rejection.mutationId}>
                {rejection.error ?? 'No reason given'}
                {rejection.missingPermission && (
                  <> — your role does not include <code>{rejection.missingPermission}</code></>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
