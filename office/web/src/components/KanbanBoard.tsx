/**
 * The stage board shared by leads and orders
 * (docs/LEAD_GENERATION_FLOW.md §4.2).
 *
 * Generic over the record because leads and orders differ only in what a card
 * says — the columns, the dragging and the move call are identical, and two
 * copies of this would drift the moment one gained a feature.
 *
 * Dragging uses the native HTML5 API rather than a library: it is a few dozen
 * lines here, and this app must run with no internet and no CDN. Because drag
 * is mouse-only, every card is also a button that opens the record, where the
 * stage can be changed from a select — so the board is never the *only* way to
 * move something.
 */

import { useState, type ReactNode } from 'react';
import type { PipelineStage } from '@orderbook/shared';

export interface BoardItem {
  id: string;
  stageId: string;
}

interface Props<T extends BoardItem> {
  stages: PipelineStage[];
  items: T[];
  renderCard: (item: T) => ReactNode;
  onMove: (item: T, stageId: string) => void;
  onOpen: (item: T) => void;
  /** Cards this board must not move — a converted lead, for instance. */
  isLocked?: (item: T) => boolean;
  emptyMessage?: string;
}

export function KanbanBoard<T extends BoardItem>({
  stages,
  items,
  renderCard,
  onMove,
  onOpen,
  isLocked,
  emptyMessage = 'Nothing here yet.',
}: Props<T>) {
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
    <div className="board">
      {ordered.map((stage) => {
        const inStage = items.filter((item) => item.stageId === stage.id);

        return (
          <section
            key={stage.id}
            className={`board-column${hoverStageId === stage.id ? ' drop-target' : ''}`}
            onDragOver={(event) => {
              // Without preventDefault the browser refuses the drop entirely —
              // the default for most elements is "not a drop target".
              event.preventDefault();
              setHoverStageId(stage.id);
            }}
            onDragLeave={() => setHoverStageId((current) => (current === stage.id ? null : current))}
            onDrop={(event) => {
              event.preventDefault();
              handleDrop(stage.id);
            }}
          >
            <header className="board-column-header">
              <span className="row" style={{ gap: 6 }}>
                <span
                  className="stage-swatch"
                  style={{ background: stage.colour ?? 'var(--muted)' }}
                  aria-hidden="true"
                />
                {stage.name}
              </span>
              <span className="count">{inStage.length}</span>
            </header>

            <div className="board-column-body">
              {inStage.length === 0 && <p className="board-column-empty">{emptyMessage}</p>}

              {inStage.map((item) => {
                const locked = isLocked?.(item) ?? false;

                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`board-card${draggingId === item.id ? ' dragging' : ''}`}
                    draggable={!locked}
                    onDragStart={() => setDraggingId(item.id)}
                    onDragEnd={() => {
                      setDraggingId(null);
                      setHoverStageId(null);
                    }}
                    onClick={() => onOpen(item)}
                    style={locked ? { cursor: 'pointer' } : undefined}
                  >
                    {renderCard(item)}
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
