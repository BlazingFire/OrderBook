/**
 * KanbanBoard (§9.3) — the stage board shared by leads and orders. Generic
 * over the record because leads and orders differ only in what a card says;
 * the columns, dragging and move call are identical. Drag uses the native
 * HTML5 API — a few dozen lines, no library, no CDN dependency — and every
 * card is also a button that opens the record, so the board is never the
 * only way to move something (drag is mouse-only).
 */

import { useState } from 'react';
import type { ReactNode } from 'react';

export interface BoardStage {
  id: string;
  name: string;
  sequence: number;
  colour?: string | null;
}

export interface BoardItem {
  id: string;
  stageId: string;
}

export function KanbanBoard<T extends BoardItem>({
  stages,
  items,
  renderCard,
  onMove,
  onOpen,
  isLocked,
  emptyMessage = 'Nothing here yet.',
  renderColumnExtra,
}: {
  stages: BoardStage[];
  items: T[];
  renderCard: (item: T) => ReactNode;
  onMove: (item: T, stageId: string) => void;
  onOpen: (item: T) => void;
  /** Cards this board must not move — a converted lead, for instance. */
  isLocked?: (item: T) => boolean;
  emptyMessage?: string;
  /** Rendered at the right of a column's header — a stage total, say. */
  renderColumnExtra?: (stageId: string) => ReactNode;
}) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [hoverStageId, setHoverStageId] = useState<string | null>(null);

  const ordered = [...stages].sort((a, b) => a.sequence - b.sequence);

  function handleDrop(stageId: string): void {
    const item = items.find((candidate) => candidate.id === draggingId);
    setDraggingId(null);
    setHoverStageId(null);
    if (!item || item.stageId === stageId) return;
    if (isLocked?.(item)) return;
    onMove(item, stageId);
  }

  return (
    <div className="ob-board">
      {ordered.map((stage) => {
        const inStage = items.filter((item) => item.stageId === stage.id);
        return (
          <section
            key={stage.id}
            className={`ob-boardcol${hoverStageId === stage.id ? ' ob-boardcol--drop' : ''}`}
            aria-label={stage.name}
            onDragOver={(e) => {
              e.preventDefault();
              setHoverStageId(stage.id);
            }}
            onDragLeave={() => setHoverStageId((c) => (c === stage.id ? null : c))}
            onDrop={(e) => {
              e.preventDefault();
              handleDrop(stage.id);
            }}
          >
            <header className="ob-boardcol-head">
              <span
                aria-hidden="true"
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: stage.colour ?? 'var(--line-strong)',
                  flex: 'none',
                }}
              />
              <span className="ob-eyebrow">{stage.name}</span>
              <span className="ob-micro" style={{ color: 'var(--fg-tertiary)' }}>
                {inStage.length}
              </span>
              <span style={{ flex: 1 }} />
              {renderColumnExtra?.(stage.id)}
            </header>
            <div className="ob-boardcol-body">
              {inStage.length === 0 && (
                <p className="ob-small" style={{ margin: '8px 4px' }}>
                  {emptyMessage}
                </p>
              )}
              {inStage.map((item) => {
                const locked = isLocked?.(item) ?? false;
                return (
                  // A card carries its own interactive controls (a kebab menu, say),
                  // which an HTML <button> cannot legally nest — role="button" on a
                  // div gets the same keyboard affordance without that restriction.
                  <div
                    key={item.id}
                    role="button"
                    tabIndex={0}
                    className={`ob-boardcard${draggingId === item.id ? ' ob-boardcard--dragging' : ''}`}
                    draggable={!locked}
                    onDragStart={() => setDraggingId(item.id)}
                    onDragEnd={() => {
                      setDraggingId(null);
                      setHoverStageId(null);
                    }}
                    onDoubleClick={() => onOpen(item)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') onOpen(item);
                    }}
                  >
                    {renderCard(item)}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
