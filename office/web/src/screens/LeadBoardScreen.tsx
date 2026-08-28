/**
 * The lead pipeline (docs/LEAD_GENERATION_FLOW.md §4).
 *
 * Columns are the tenant's configured stages, so this screen never names one.
 * Converted leads leave the board — they are history now, and their order runs
 * the workflow from that point.
 *
 * Board/List/filters are published into the shell's filter strip (§8); the
 * open lead renders in a 520px Drawer over the board so the list keeps its
 * scroll position, and can expand full-screen from the Drawer's own header
 * control (§8 — Lead and Order detail are the two screens allowed to).
 */

import { useState } from 'react';
import type { Lead, PartyScopeFilter, SyncSnapshot } from '@orderbook/shared';

import { api, type LocalView } from '../api';
import {
  ColourChip,
  DataTable,
  Drawer,
  EmptyState,
  FilterChip,
  FilterDivider,
  IconButton,
  KanbanBoard,
  Popover,
  Segmented,
  StatusPill,
  formatMoney,
  t,
  useColourHex,
  useFilterBar,
  useToast,
  type DataTableColumn,
} from '@orderbook/ui';
import { LeadDetail } from './LeadDetail';

interface Props {
  view: LocalView;
  canConvert: boolean;
  onError: (message: string) => void;
  onAddLead?: () => void;
}

type BoardTab = 'board' | 'list';

function leadBoxes(lead: Lead): number {
  return lead.items.reduce((sum, item) => sum + item.totalQuantity, 0);
}

function leadColours(lead: Lead): string[] {
  return Array.from(new Set(lead.items.flatMap((item) => item.quantities.map((q) => q.colour))));
}

/**
 * "My parties" — the leads or orders on parties explicitly assigned to the
 * signed-in person.
 *
 * A narrowing of what is already on screen, never a widening: the snapshot the
 * Master built for this person has already dropped everything they may not see,
 * so this only hides the *unassigned* parties they can reach like everyone
 * else. `partyGrants` absent (an older Master) leaves the list untouched.
 */
function onMyParties<T extends { partyId: string }>(
  rows: T[],
  grants: SyncSnapshot['partyGrants'],
): T[] {
  if (!grants) return rows;
  const mine = new Set(grants.map((grant) => grant.partyId));
  return rows.filter((row) => mine.has(row.partyId));
}

export function LeadBoardScreen({ view, canConvert, onError, onAddLead }: Props) {
  const [tab, setTab] = useState<BoardTab>('board');
  const [stageFilter, setStageFilter] = useState<string | null>(null);
  const [scope, setScope] = useState<PartyScopeFilter>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [menuId, setMenuId] = useState<string | null>(null);
  const colourHex = useColourHex(view.optionLists);
  const toast = useToast();

  const pipeline = view.pipelines.find((candidate) => candidate.kind === 'lead');
  const stages = [...(pipeline?.stages ?? [])].sort((a, b) => a.sequence - b.sequence);
  const open = onMyParties(
    view.leads.filter((lead) => !lead.convertedOrderId),
    scope === 'assigned' ? view.partyGrants : undefined,
  );
  const filtered = stageFilter ? open.filter((lead) => lead.stageId === stageFilter) : open;
  const openLead = view.leads.find((lead) => lead.id === openId) ?? null;

  useFilterBar(
    pipeline ? (
      <>
        <Segmented
          options={[
            { value: 'board' as const, label: t('lead.board.tab.board') },
            { value: 'list' as const, label: t('lead.board.tab.list') },
          ]}
          value={tab}
          onChange={setTab}
        />
        <FilterDivider />
        <Segmented
          options={[
            { value: 'all' as const, label: t('partyAccess.scope.all') },
            { value: 'assigned' as const, label: t('partyAccess.scope.assigned') },
          ]}
          value={scope}
          onChange={setScope}
        />
        <FilterDivider />
        <FilterChip
          active={stageFilter === null}
          count={open.length}
          onClick={() => setStageFilter(null)}
        >
          {t('lead.board.filter.all')}
        </FilterChip>
        {stages.map((stage) => (
          <FilterChip
            key={stage.id}
            active={stageFilter === stage.id}
            count={open.filter((lead) => lead.stageId === stage.id).length}
            onClick={() => setStageFilter(stage.id)}
          >
            {stage.name}
          </FilterChip>
        ))}
        <span style={{ flex: 1 }} />
        <span className="ob-small">{t('lead.board.convertedNote')}</span>
      </>
    ) : null,
  );

  if (!pipeline) {
    return (
      <EmptyState
        title={t('lead.board.noPipelineTitle')}
        description={t('lead.board.noPipelineDesc')}
      />
    );
  }

  async function move(lead: Lead, stageId: string): Promise<void> {
    try {
      await api.setLeadStage(lead.id, stageId);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : 'Could not move the lead');
    }
  }

  /**
   * The kebab menu's quick convert — same call and permission/packaging
   * checks as the Convert button in `LeadDetail`, minus that button's
   * dispatch-label/date fields (this is the one-click path from the board).
   */
  async function convertFromBoard(lead: Lead): Promise<void> {
    try {
      const result = await api.convertLead(lead.id);
      toast.push(t('lead.board.convertedToast', { boxes: leadBoxes(lead), orderId: result.id }));
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : 'Could not convert the lead');
    }
  }

  function closeDrawer(): void {
    setOpenId(null);
    setExpanded(false);
  }

  const columns: DataTableColumn<Lead>[] = [
    {
      key: 'id',
      header: t('lead.list.col.lead'),
      width: '130px',
      render: (lead) => (
        <span className="ob-mono" style={{ fontSize: 12 }}>
          {lead.id}
        </span>
      ),
    },
    { key: 'party', header: t('lead.list.col.party'), render: (lead) => lead.partyName },
    {
      key: 'stage',
      header: t('lead.list.col.stage'),
      width: '110px',
      render: (lead) => lead.stageName,
    },
    {
      key: 'source',
      header: t('lead.list.col.source'),
      width: '110px',
      render: (lead) => lead.sourcePlatform ?? '—',
    },
    {
      key: 'boxes',
      header: t('lead.list.col.boxes'),
      width: '80px',
      align: 'right',
      render: (lead) => String(leadBoxes(lead)),
    },
    {
      key: 'amount',
      header: t('lead.list.col.amount'),
      width: '110px',
      align: 'right',
      render: (lead) => (lead.totalAmount !== undefined ? formatMoney(lead.totalAmount) : '—'),
    },
    {
      key: 'followUp',
      header: t('lead.list.col.followUp'),
      width: '100px',
      render: (lead) => lead.followUpDate ?? '—',
    },
    {
      key: 'sync',
      header: t('lead.list.col.sync'),
      width: '90px',
      render: (lead) => (
        <span
          className="ob-micro"
          style={{ color: lead.sync.hlc ? 'var(--fg-tertiary)' : 'var(--state-offline)' }}
        >
          {lead.sync.hlc ? t('lead.list.synced') : t('lead.list.pending')}
        </span>
      ),
    },
  ];

  return (
    <>
      {tab === 'board' ? (
        <KanbanBoard
          stages={stages}
          items={filtered}
          onMove={(lead, stageId) => void move(lead, stageId)}
          onOpen={(lead) => setOpenId(lead.id)}
          emptyMessage={t('lead.board.emptyColumn')}
          renderColumnExtra={(stageId) => {
            const stageTotal = filtered
              .filter((lead) => lead.stageId === stageId)
              .reduce((sum, lead) => sum + (lead.totalAmount ?? 0), 0);
            return stageTotal > 0 ? (
              <span className="ob-micro" style={{ color: 'var(--fg-tertiary)' }}>
                {formatMoney(stageTotal)}
              </span>
            ) : null;
          }}
          renderCard={(lead) => {
            const boxes = leadBoxes(lead);
            const colours = leadColours(lead);
            const stageIndex = stages.findIndex((stage) => stage.id === lead.stageId);
            const nextStage =
              stageIndex >= 0 && stageIndex < stages.length - 1 ? stages[stageIndex + 1] : null;
            const missingPackaging = lead.items.some((item) => !item.packaging?.trim());
            return (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-6)' }}>
                  <span className="ob-body-strong" style={{ fontSize: 13 }}>
                    {lead.partyName}
                  </span>
                  <span style={{ flex: 1 }} />
                  {/* An empty hlc means the Master has not acknowledged it yet. */}
                  {!lead.sync.hlc && (
                    <StatusPill tone="offline">{t('lead.badge.notSynced')}</StatusPill>
                  )}
                  {lead.incomplete && (
                    <StatusPill tone="conflict">{t('lead.badge.incomplete')}</StatusPill>
                  )}
                  <IconButton
                    icon="more"
                    label={t('lead.board.cardMenu')}
                    onClick={(event) => {
                      event.stopPropagation();
                      setMenuId((current) => (current === lead.id ? null : lead.id));
                    }}
                  />
                  <Popover
                    open={menuId === lead.id}
                    onClose={() => setMenuId(null)}
                    anchorStyle={{
                      right: 'var(--s-8)',
                      top: 'calc(var(--s-12) + var(--ctl-h-sm))',
                    }}
                  >
                    <div className="ob-menu">
                      <button
                        type="button"
                        className="ob-menu-item ob-body"
                        onClick={(event) => {
                          event.stopPropagation();
                          setMenuId(null);
                          setOpenId(lead.id);
                        }}
                      >
                        {t('lead.board.menu.open')}
                      </button>
                      {nextStage && (
                        <button
                          type="button"
                          className="ob-menu-item ob-body"
                          onClick={(event) => {
                            event.stopPropagation();
                            setMenuId(null);
                            void move(lead, nextStage.id);
                          }}
                        >
                          {t('lead.board.menu.moveTo', { stage: nextStage.name })}
                        </button>
                      )}
                      <button
                        type="button"
                        className="ob-menu-item ob-body"
                        disabled={!canConvert || missingPackaging}
                        title={
                          !canConvert
                            ? t('lead.detail.noPermission')
                            : missingPackaging
                              ? t('lead.board.menu.convertBlocked')
                              : undefined
                        }
                        onClick={(event) => {
                          event.stopPropagation();
                          setMenuId(null);
                          void convertFromBoard(lead);
                        }}
                      >
                        {t('lead.board.menu.convert')}
                      </button>
                    </div>
                  </Popover>
                </div>

                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--s-6)',
                    marginTop: 'var(--s-4)',
                  }}
                >
                  <span className="ob-mono" style={{ fontSize: 11.5, color: 'var(--fg-tertiary)' }}>
                    {lead.id}
                  </span>
                  <span className="ob-small">
                    · {lead.items.length}{' '}
                    {lead.items.length === 1 ? t('unit.product') : t('unit.products')} · {boxes}{' '}
                    {t('unit.boxes')}
                  </span>
                </div>

                {colours.length > 0 && (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 'var(--s-8)',
                      marginTop: 'var(--s-6)',
                    }}
                  >
                    <span
                      style={{
                        display: 'inline-flex',
                        gap: 'var(--s-8)',
                        overflow: 'hidden',
                        flex: 1,
                        minWidth: 0,
                      }}
                    >
                      {colours.map((colour) => (
                        <ColourChip key={colour} name={colour} hex={colourHex(colour)} />
                      ))}
                    </span>
                    <span className="ob-small" style={{ fontWeight: 500 }}>
                      {lead.totalAmount !== undefined ? formatMoney(lead.totalAmount) : '—'}
                    </span>
                  </div>
                )}

                <div
                  style={{ display: 'flex', gap: 'var(--s-8)', marginTop: 'var(--s-6)' }}
                  className="ob-micro"
                >
                  {lead.sourcePlatform && (
                    <span style={{ color: 'var(--fg-tertiary)' }}>via {lead.sourcePlatform}</span>
                  )}
                  <span style={{ flex: 1 }} />
                  {lead.followUpDate && (
                    <span style={{ color: 'var(--fg-tertiary)' }}>
                      {t('lead.detail.followUp')} {lead.followUpDate}
                    </span>
                  )}
                </div>
              </>
            );
          }}
        />
      ) : (
        <DataTable
          columns={columns}
          rows={filtered}
          rowKey={(lead) => lead.id}
          onRowOpen={(lead) => setOpenId(lead.id)}
          selectedId={openId ?? undefined}
          empty={
            <EmptyState
              title={t('lead.board.emptyTitle')}
              description={t('lead.board.emptyDesc')}
              actionLabel={onAddLead ? t('action.newLead') : undefined}
              onAction={onAddLead}
            />
          }
        />
      )}

      <Drawer
        open={Boolean(openLead)}
        onClose={closeDrawer}
        expanded={expanded}
        onToggleExpand={() => setExpanded((value) => !value)}
        title={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-8)' }}>
            {openLead?.partyName}
            {openLead && !openLead.sync.hlc && (
              <StatusPill tone="offline">{t('lead.badge.notSynced')}</StatusPill>
            )}
            {openLead?.convertedOrderId && (
              <StatusPill tone="ok">{t('lead.badge.converted')}</StatusPill>
            )}
          </span>
        }
        subtitle={openLead && <span className="ob-mono">{openLead.id}</span>}
      >
        {openLead && (
          <LeadDetail
            lead={openLead}
            view={view}
            canConvert={canConvert}
            onClose={closeDrawer}
            onError={onError}
          />
        )}
      </Drawer>
    </>
  );
}
