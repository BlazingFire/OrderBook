/**
 * The presence rail (§7): a 3px full-height strip on the extreme left of every
 * window. Connection state as a permanent physical edge, not a badge in a
 * corner. Static in every state except the one where something is actually
 * moving; clicking it opens the sync detail popover.
 */

export type RailState = 'synced' | 'syncing' | 'offline' | 'offlinePending' | 'conflict';

interface RailLook {
  background: string;
  opacity?: number;
  moving?: boolean;
}

const LOOKS: Record<RailState, RailLook> = {
  synced: { background: 'var(--line)' },
  syncing: { background: 'var(--accent)', moving: true },
  offline: { background: 'var(--state-offline)', opacity: 0.4 },
  offlinePending: { background: 'var(--state-offline)' },
  conflict: { background: 'var(--state-conflict)' },
};

export function PresenceRail({
  state,
  label,
  onClick,
}: {
  state: RailState;
  /** Same string as the footer's sync text; also the accessible name. */
  label: string;
  onClick: () => void;
}) {
  const look = LOOKS[state];
  return (
    <button
      type="button"
      className="ob-rail"
      style={{ background: look.background, opacity: look.opacity ?? 1 }}
      aria-label={`Sync status: ${label}`}
      title={label}
      onClick={onClick}
    >
      {look.moving && <span className="ob-rail-highlight" />}
    </button>
  );
}
