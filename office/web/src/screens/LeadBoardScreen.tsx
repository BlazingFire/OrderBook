/**
 * The lead pipeline (docs/LEAD_GENERATION_FLOW.md §4).
 *
 * Columns are the tenant's configured stages, so this screen never names one.
 * Converted leads leave the board — they are history now, and their order runs
 * the workflow from that point.
 */

import { useState } from 'react';
import type { Lead } from '@orderbook/shared';

import { api, type LocalView } from '../api';
import { KanbanBoard } from '../components/KanbanBoard';
import { formatMoney } from '../format';
import { LeadDetail } from './LeadDetail';

interface Props {
  view: LocalView;
  canConvert: boolean;
  onError: (message: string) => void;
}

export function LeadBoardScreen({ view, canConvert, onError }: Props) {
  const [openId, setOpenId] = useState<string | null>(null);

  const pipeline = view.pipelines.find((candidate) => candidate.kind === 'lead');
  const open = view.leads.filter((lead) => !lead.convertedOrderId);
  const openLead = view.leads.find((lead) => lead.id === openId) ?? null;

  if (!pipeline) {
    return (
      <div className="card">
        <p className="muted">Waiting for the pipeline configuration from the Master Panel…</p>
      </div>
    );
  }

  async function move(lead: Lead, stageId: string): Promise<void> {
    try {
      await api.setLeadStage(lead.id, stageId);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : 'Could not move the lead');
    }
  }

  if (openLead) {
    return (
      <LeadDetail
        lead={openLead}
        view={view}
        canConvert={canConvert}
        onClose={() => setOpenId(null)}
        onError={onError}
      />
    );
  }

  return (
    <KanbanBoard
      stages={pipeline.stages}
      items={open}
      onMove={(lead, stageId) => void move(lead, stageId)}
      onOpen={(lead) => setOpenId(lead.id)}
      emptyMessage="No leads at this stage."
      renderCard={(lead) => (
        <>
          <div className="board-card-title">
            {lead.partyName}
            {/* An empty hlc means the Master has not acknowledged it yet. */}
            {!lead.sync.hlc && <span className="chip pending">not synced</span>}
            {lead.incomplete && <span className="chip incomplete">incomplete</span>}
          </div>
          <div className="board-card-meta">
            {lead.id} · {lead.items.length} product{lead.items.length === 1 ? '' : 's'}
            {lead.totalAmount !== undefined && ` · ${formatMoney(lead.totalAmount)}`}
          </div>
          {lead.followUpDate && (
            <div className="board-card-meta">Follow up {lead.followUpDate}</div>
          )}
        </>
      )}
    />
  );
}
