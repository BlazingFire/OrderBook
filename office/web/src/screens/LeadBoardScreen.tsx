/**
 * The lead pipeline (docs/LEAD_GENERATION_FLOW.md §4).
 *
 * Columns are the tenant's configured stages, so this screen never names one.
 * Converted leads leave the board — they are history now, and their order runs
 * the workflow from that point.
 *
 * Board/List/filters are published into the shell's filter strip (§8). Opening
 * a lead replaces this screen with its detail: a sub-screen with one way back
 * in a fixed place, and its own entry nested under Leads in the sidebar while
 * it is open, so the shell can say what is on screen. The board is not
 * unmounted while that is showing, so its mode, filters and scroll position
 * are all still there on the way back.
 */

import { useState } from 'react';
import type { Lead, PartyScopeFilter, SyncSnapshot } from '@orderbook/shared';

import { api, type LocalView } from '../api';
import {
  ColourChip,
  DataTable,
  EditorScreen,
  EmptyState,
  FilterChip,
  FilterDivider,
  IconButton,
  KanbanBoard,
  Popover,
  Segmented,
  StatusPill,
  formatKg,
  formatMoney,
  rem,
  t,
  useColourHex,
  useFilterBar,
  useSubNav,
  useToast,
  type DataTableColumn,
} from '@orderbook/ui';
import { LeadDetail } from './LeadDetail';

interface Props {
  view: LocalView;
  /** The lead showing as a sub-screen, held by the shell so the Dashboard can open one. */
  openId: string | null;
  onOpenId: (id: string | null) => void;
  canConvert: boolean;
  onError: (message: string) => void;
  onAddLead?: () => void;
}

type BoardTab = 'board' | 'list';

function leadPieces(lead: Lead): number {
  return lead.items.reduce((sum, item) => sum + item.quantity, 0);
}

/** The colours on the lead's lines — a pattern or a one-form product has none to show. */
function leadColours(lead: Lead): string[] {
  return Array.from(
    new Set(
      lead.items
        .map((item) => item.variantLabel)
        .filter((label): label is string => label !== null),
    ),
  );
}

function leadMains(lead: Lead): string[] {
  return Array.from(
    new Set(lead.items.map((item) => item.categoryName).filter((name): name is string => Boolean(name))),
  );
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

export function LeadBoardScreen({ view, openId, onOpenId, canConvert, onError, onAddLead }: Props) {
  const [tab, setTab] = useState<BoardTab>('list');
  const [stageFilter, setStageFilter] = useState<string | null>(null);
  const [scope, setScope] = useState<PartyScopeFilter>('all');
  const [menuId, setMenuId] = useState<string | null>(null);
  const colourHex = useColourHex(view.optionLists);
  const toast = useToast();
  // Off with the company's pricing switch, or without the role's key.
  const showMoney = view.permissions.includes('field.saleRate.view');

  const pipeline = view.pipelines.find((candidate) => candidate.kind === 'lead');
  const stages = [...(pipeline?.stages ?? [])].sort((a, b) => a.sequence - b.sequence);
  const open = onMyParties(
    view.leads.filter((lead) => !lead.convertedOrderId),
    scope === 'assigned' ? view.partyGrants : undefined,
  );
  const filtered = stageFilter ? open.filter((lead) => lead.stageId === stageFilter) : open;
  const openLead = view.leads.find((lead) => lead.id === openId) ?? null;

  useFilterBar(
    pipeline && !openLead ? (
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

  useSubNav(
    'leads',
    openLead
      ? {
          parentId: 'leads',
          items: [{ id: 'leads.detail', label: openLead.partyName, icon: 'leads' }],
          activeId: 'leads.detail',
        }
      : null,
  );

  if (openLead) {
    return (
      <EditorScreen
        title={openLead.partyName}
        meta={
          <>
            {!openLead.sync.hlc && (
              <StatusPill tone="offline">{t('lead.badge.notSynced')}</StatusPill>
            )}
            {openLead.convertedOrderId && (
              <StatusPill tone="ok">{t('lead.badge.converted')}</StatusPill>
            )}
            <span className="ob-mono ob-small">{openLead.id}</span>
          </>
        }
        onBack={() => {
          onOpenId(null);
          return true;
        }}
        backLabel={t('action.backToList')}
      >
        <LeadDetail
          lead={openLead}
          view={view}
          canConvert={canConvert}
          onClose={() => onOpenId(null)}
          onError={onError}
        />
      </EditorScreen>
    );
  }

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
      toast.push(t('lead.board.convertedToast', { qty: leadPieces(lead), orderId: result.id }));
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : 'Could not convert the lead');
    }
  }

  const columns: DataTableColumn<Lead>[] = [
    {
      key: 'id',
      header: t('lead.list.col.lead'),
      width: rem(130),
      render: (lead) => (
        <span className="ob-mono" style={{ fontSize: rem(12) }}>
          {lead.id}
        </span>
      ),
    },
    { key: 'party', header: t('lead.list.col.party'), render: (lead) => lead.partyName },
    {
      key: 'products',
      header: t('lead.list.col.products'),
      priority: 2,
      render: (lead) => {
        const mains = leadMains(lead);
        const names = lead.items.map((item) => item.productName).join(', ');
        return (
          <span
            className="ob-small ob-ellipsis"
            title={mains.length ? `${mains.join(' · ')}\n${names}` : names}
            style={{ display: 'block' }}
          >
            {mains.length ? mains.join(' · ') : names}
          </span>
        );
      },
    },
    {
      key: 'stage',
      header: t('lead.list.col.stage'),
      width: rem(110),
      render: (lead) => lead.stageName,
    },
    {
      key: 'source',
      header: t('lead.list.col.source'),
      priority: 3,
      width: rem(110),
      render: (lead) => lead.sourcePlatform ?? '—',
    },
    {
      key: 'qty',
      header: t('lead.list.col.qty'),
      priority: 2,
      width: rem(80),
      align: 'right',
      render: (lead) => String(leadPieces(lead)),
    },
    {
      key: 'weight',
      header: t('lead.list.col.weight'),
      priority: 3,
      width: rem(110),
      align: 'right',
      render: (lead) =>
        lead.linesWithoutWeight > 0 ? (
          <span title={t('lead.detail.linesWithoutWeight', { count: lead.linesWithoutWeight })}>
            {formatKg(lead.totalWeightKg)}
            <span style={{ color: 'var(--state-offline)' }}> *</span>
          </span>
        ) : (
          formatKg(lead.totalWeightKg)
        ),
    },
    ...(showMoney
      ? [
          {
            key: 'amount',
            header: t('lead.list.col.amount'),
            width: rem(110),
            align: 'right',
            render: (lead: Lead) =>
              lead.totalAmount !== undefined ? formatMoney(lead.totalAmount) : '—',
          } satisfies DataTableColumn<Lead>,
        ]
      : []),
    {
      key: 'followUp',
      header: t('lead.list.col.followUp'),
      priority: 3,
      width: rem(100),
      render: (lead) => lead.followUpDate ?? '—',
    },
    {
      key: 'sync',
      header: t('lead.list.col.sync'),
      width: rem(90),
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
          onOpen={(lead) => onOpenId(lead.id)}
          emptyMessage={t('lead.board.emptyColumn')}
          renderColumnExtra={(stageId) => {
            if (!showMoney) return null;
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
            const pieces = leadPieces(lead);
            const colours = leadColours(lead);
            const mains = leadMains(lead);
            const stageIndex = stages.findIndex((stage) => stage.id === lead.stageId);
            const nextStage =
              stageIndex >= 0 && stageIndex < stages.length - 1 ? stages[stageIndex + 1] : null;
            const missingPackaging = lead.items.some((item) => !item.packaging?.trim());
            return (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-6)' }}>
                  <span className="ob-body-strong" style={{ fontSize: rem(13) }}>
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
                          onOpenId(lead.id);
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
                  <span
                    className="ob-mono"
                    style={{ fontSize: rem(11.5), color: 'var(--fg-tertiary)' }}
                  >
                    {lead.id}
                  </span>
                  <span className="ob-small">
                    · {lead.items.length}{' '}
                    {lead.items.length === 1 ? t('unit.line') : t('unit.lines')} · {pieces}{' '}
                    {t('unit.pieces')}
                    {lead.totalWeightKg > 0 ? ` · ${formatKg(lead.totalWeightKg)}` : ''}
                  </span>
                </div>

                {mains.length > 0 && (
                  <div
                    className="ob-micro ob-ellipsis"
                    style={{ color: 'var(--fg-tertiary)', marginTop: 'var(--s-4)' }}
                  >
                    {mains.join(' · ')}
                  </div>
                )}

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
                    {showMoney && (
                      <span className="ob-small" style={{ fontWeight: 500 }}>
                        {lead.totalAmount !== undefined ? formatMoney(lead.totalAmount) : '—'}
                      </span>
                    )}
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
          onRowOpen={(lead) => onOpenId(lead.id)}
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
    </>
  );
}
