import type { DashboardSummary, OfficePanelWithPresence } from '@orderbook/shared';

interface Props {
  summary: DashboardSummary | null;
  panels: OfficePanelWithPresence[];
}

export function DashboardScreen({ summary, panels }: Props) {
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
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3 style={{ marginTop: 0 }}>
          Office panels — {connected} of {active.length} online
        </h3>
        {active.length === 0 ? (
          <p className="muted">No office panels connected yet. Add one from the Office Panels tab.</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {active.map((panel) => (
              <li key={panel.id} style={{ marginBottom: 4 }}>
                <span className={`dot ${panel.isConnected ? 'on' : 'off'}`} />
                {panel.name} <span className="muted">({panel.lanIp ?? 'unknown address'})</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | undefined }) {
  return (
    <div className="card" style={{ marginBottom: 0 }}>
      <div className="muted">{label}</div>
      <div style={{ fontSize: 30, fontWeight: 600 }}>{value ?? '—'}</div>
    </div>
  );
}
