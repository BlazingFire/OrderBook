import type { DashboardSummary, OfficePanelWithPresence } from '@orderbook/shared';

interface Props {
  summary: DashboardSummary | null;
  panels: OfficePanelWithPresence[];
  onOpenConflicts: () => void;
}

export function DashboardScreen({ summary, panels, onOpenConflicts }: Props) {
  const connected = panels.filter((panel) => panel.isConnected).length;
  const active = panels.filter((panel) => panel.status === 'active');

  return (
    <div>
      <h2>Dashboard</h2>

      <div className="grid cols-4">
        <Stat label="Open leads" value={summary?.leadCount} />
        <Stat label="Orders" value={summary?.orderCount} />
        <Stat label="Parties" value={summary?.partyCount} />
        <Stat label="Products" value={summary?.productCount} />
        <Stat
          label="Low stock"
          value={summary?.lowStockCount}
          alert={(summary?.lowStockCount ?? 0) > 0}
        />
        <Stat
          label="Follow-ups due"
          value={summary?.followUpsDueCount}
          alert={(summary?.followUpsDueCount ?? 0) > 0}
        />
        <Stat
          label="Conflicts to review"
          value={summary?.openConflictCount}
          alert={(summary?.openConflictCount ?? 0) > 0}
          onClick={(summary?.openConflictCount ?? 0) > 0 ? onOpenConflicts : undefined}
        />
        {/* Panels can hold work this Master has never seen, so this counts what
            arrived recently rather than claiming to know what is outstanding. */}
        <Stat label="Synced in the last hour" value={summary?.pendingSyncCount} />
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3 style={{ marginTop: 0 }}>
          Office panels — {connected} of {active.length} online
        </h3>
        {active.length === 0 ? (
          <p className="muted">
            No office panels connected yet. Add one from the Office Panels tab.
          </p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {active.map((panel) => (
              <li key={panel.id} style={{ marginBottom: 4 }}>
                <span className={`dot ${panel.isConnected ? 'on' : 'off'}`} />
                {panel.name}{' '}
                <span className="muted">
                  ({panel.lanIp ?? 'unknown address'} · device {panel.deviceCode})
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="muted" style={{ marginBottom: 0, marginTop: 10 }}>
          A panel that is offline is still taking leads — they arrive here when it reconnects.
        </p>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  alert = false,
  onClick,
}: {
  label: string;
  value: number | undefined;
  alert?: boolean;
  onClick?: () => void;
}) {
  const content = (
    <>
      <div className="muted">{label}</div>
      <div style={{ fontSize: 30, fontWeight: 600, color: alert ? 'var(--danger)' : undefined }}>
        {value ?? '—'}
      </div>
    </>
  );

  if (!onClick) {
    return (
      <div className="card" style={{ marginBottom: 0 }}>
        {content}
      </div>
    );
  }

  return (
    <button
      className="card secondary"
      style={{ marginBottom: 0, textAlign: 'left', display: 'block', width: '100%' }}
      onClick={onClick}
    >
      {content}
    </button>
  );
}
