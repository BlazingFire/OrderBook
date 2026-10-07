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

import { useDeferredValue, useEffect, useRef, useState } from 'react';
import { matchesRecordSearch, resolveCompanyFeatures, shownColour } from '@orderbook/shared';
import type { ChatRecordChip, Lead, NoteKind, PartyScopeFilter, SyncSnapshot } from '@orderbook/shared';

import { api, desktopBridge, type LocalView } from '../api';
import { presenceChannel } from '../presence';
import {
  AvatarStack,
  BOARD_SHOWN,
  Button,
  ButtonLink,
  ColourChip,
  DataTable,
  PageBar,
  pageWindow,
  usePageSize,
  EditorScreen,
  EmptyState,
  FilterChip,
  FilterDivider,
  Input,
  IconButton,
  KanbanBoard,
  OrderNoteScreen,
  Popover,
  RecordNumber,
  Segmented,
  StatusPill,
  formatKg,
  recordNumberText,
  rem,
  t,
  useColourHex,
  useFilterBar,
  useBoardPresence,
  useRecordPresence,
  useSubNav,
  useToast,
  type DataTableColumn,
  type PrintroomTransport,
  NoteButtons,
} from '@orderbook/ui';
import { AddLeadScreen } from './AddLeadScreen';
import { LeadDetail } from './LeadDetail';

interface Props {
  view: LocalView;
  /** The lead showing as a sub-screen, held by the shell so the Dashboard can open one. */
  openId: string | null;
  onOpenId: (id: string | null) => void;
  canConvert: boolean;
  /** `leads.export` — the open lead's header offers Preview PDF and the Filling and Dispatch notes. */
  canPreviewPdf: boolean;
  /** `leads.edit` — the open lead's header offers Edit lead. */
  canEdit: boolean;
  onError: (message: string) => void;
  onAddLead?: () => void;
  /** Present only for somebody who may share records in chat (`chat.use` and `chat.shareRecords`). */
  onShareInChat?: (chip: ChatRecordChip) => void;
  /** Present only for somebody who may send to the Printroom (`print.send`): the note screen offers it. */
  printroom?: PrintroomTransport;
  /** The signed-in person, left out of who else is on the open lead. */
  userId?: string | null;
  /** Temporary id → permanent id, for provisional leads the Master has numbered. */
  numberedIds?: Record<string, string>;
}

type BoardTab = 'board' | 'list';

function leadPieces(lead: Lead): number {
  return lead.items.reduce((sum, item) => sum + item.quantity, 0);
}

/**
 * The colours on the card: the colour chosen on a multi-colour line, or the
 * variant's own — less one that only repeats the name, `MAGENTA` in Magenta
 * (CATALOGUE_MODEL §2). A dedicated sub product has none to show.
 */
function leadColours(lead: Lead): string[] {
  return Array.from(
    new Set(
      lead.items
        .map((item) => item.colour ?? shownColour(item.variantLabel, item.productName))
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

export function LeadBoardScreen({
  view,
  openId,
  onOpenId,
  canConvert,
  canPreviewPdf,
  canEdit,
  onError,
  onAddLead,
  onShareInChat,
  printroom,
  userId,
  numberedIds,
}: Props) {
  /** The open lead whose lines are in the entry form, or null. */
  const [editingId, setEditingId] = useState<string | null>(null);
  /** The Filling or Dispatch note open over a pending order, when there is one. */
  const [note, setNote] = useState<{ id: string; kind: NoteKind } | null>(null);
  const [tab, setTab] = useState<BoardTab>('list');
  const [stageFilter, setStageFilter] = useState<string | null>(null);
  const [pageSize, setPageSize] = usePageSize('office-leads');
  const [paging, setPaging] = useState<{ key: string; page: number }>({ key: '', page: 0 });
  const [scope, setScope] = useState<PartyScopeFilter>('all');
  const [search, setSearch] = useState('');
  // The box stays instant; the filter over a big board catches up between keystrokes.
  const deferredSearch = useDeferredValue(search);
  const [menuId, setMenuId] = useState<string | null>(null);
  const colourHex = useColourHex(view.optionLists);
  const toast = useToast();
  // `leads.packagingRequiredOnConvert`, resolved at this panel's edge. At
  // component scope, not inside `renderCard` — `renderCard` closes over it.
  const packagingRequired = resolveCompanyFeatures(view.features).packagingRequiredOnConvert;

  const pipeline = view.pipelines.find((candidate) => candidate.kind === 'lead');
  const stages = [...(pipeline?.stages ?? [])].sort((a, b) => a.sequence - b.sequence);
  const open = onMyParties(
    view.leads.filter((lead) => !lead.convertedOrderId),
    scope === 'assigned' ? view.partyGrants : undefined,
  );
  // What the stage chips count: this panel holds every lead, so under the search and "my parties" they are true totals.
  const countable = open.filter((lead) => matchesRecordSearch(lead, search));
  const filtered = (stageFilter ? open.filter((lead) => lead.stageId === stageFilter) : open).filter(
    (lead) => matchesRecordSearch(lead, deferredSearch),
  );
  // The list view shows one page of what the filters leave; the filters run over all of it first.
  const pageKey = `${scope}|${search}|${stageFilter ?? ''}|${pageSize}`;
  const leadPage = pageWindow(filtered.length, paging.key === pageKey ? paging.page : 0, pageSize);
  const pagedLeads = filtered.slice(leadPage.offset, leadPage.offset + pageSize);
  // A provisional lead opened before the Master numbered it stays open once
  // its permanent record replaces it here.
  const renamedTo = openId ? numberedIds?.[openId] : undefined;
  const inView =
    view.leads.find((lead) => lead.id === openId) ??
    (renamedTo ? view.leads.find((lead) => lead.id === renamedTo) : undefined) ??
    null;
  /*
   * A lead this panel's 500-row view does not hold (a chat chip, a bell entry):
   * asked of the Master through this panel's server, which applies the person's
   * party scope. Gone or not theirs to see: back to the list, with a word.
   */
  const [fetched, setFetched] = useState<Lead | null>(null);
  const onOpenIdRef = useRef(onOpenId);
  onOpenIdRef.current = onOpenId;
  const inViewNow = inView !== null;
  useEffect(() => {
    if (!openId || inViewNow) {
      setFetched(null);
      return;
    }
    let cancelled = false;
    void api.lead(openId).then(
      (lead) => {
        if (!cancelled) setFetched(lead);
      },
      () => {
        if (cancelled) return;
        toast.push(t('nav.recordNotAvailable'), { tone: 'info' });
        onOpenIdRef.current(null);
      },
    );
    return () => {
      cancelled = true;
    };
    // `toast` is a stable context value; the open id and whether the view holds it decide this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId, inViewNow]);
  const openLead = inView ?? (fetched && fetched.id === openId ? fetched : null);

  useFilterBar(
    pipeline && !openLead ? (
      <>
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t('leads.search.placeholder')}
          aria-label={t('leads.search.label')}
          data-screen-search
          style={{ width: rem(320) }}
        />
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
          count={countable.length}
          onClick={() => setStageFilter(null)}
        >
          {t('lead.board.filter.all')}
        </FilterChip>
        {stages.map((stage) => (
          <FilterChip
            key={stage.id}
            active={stageFilter === stage.id}
            count={countable.filter((lead) => lead.stageId === stage.id).length}
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

  const noteKind = note && note.id === openLead?.id ? note.kind : null;

  useSubNav(
    'leads',
    openLead
      ? {
          parentId: 'leads',
          items: [
            {
              id: noteKind ? 'leads.note' : 'leads.detail',
              label: openLead.partyName,
              icon: 'leads',
            },
          ],
          activeId: noteKind ? 'leads.note' : 'leads.detail',
        }
      : null,
  );

  // Who else has the open lead up, and whether they are editing it. A
  // provisional one is never announced: the Master has not heard of it.
  const presence = useRecordPresence(
    presenceChannel,
    openLead ? { recordKind: 'lead', recordId: openLead.id } : null,
    openLead !== null && editingId === openLead.id,
  );

  // Who has each card or row open (R22), for the faces on it.
  const faces = useBoardPresence(presenceChannel, 'lead');
  const others = <AvatarStack entries={presence.entries} selfUserId={userId} />;

  // The note of a pending order, drawn from the lead and party this panel
  // already holds, so it previews and prints with the Master unreachable. Its
  // vehicle number is for the sheet only (`OrderNoteScreen`).
  if (openLead && noteKind) {
    return (
      <OrderNoteScreen
        key={openLead.id}
        record={openLead}
        source="lead"
        party={view.parties.find((candidate) => candidate.id === openLead.partyId) ?? null}
        initialKind={noteKind}
        canEditVehicle
        onSaveVehicle={async () => undefined}
        onBack={() => setNote(null)}
        desktop={desktopBridge() ?? undefined}
        printroom={printroom}
      />
    );
  }

  if (openLead && editingId === openLead.id) {
    return (
      <EditorScreen
        title={openLead.partyName}
        meta={<RecordNumber record={openLead} small />}
        actions={others}
        onBack={() => {
          setEditingId(null);
          return true;
        }}
        backLabel={t('action.cancel')}
      >
        <AddLeadScreen
          key={openLead.id}
          view={view}
          lead={openLead}
          remoteChange={presence.lastWrite}
          onSaved={() => {
            setEditingId(null);
            toast.push(t('lead.edit.saved', { id: recordNumberText(openLead) }));
          }}
          onCancel={() => setEditingId(null)}
        />
      </EditorScreen>
    );
  }

  if (openLead) {
    // A converted lead is locked on the Master, and one it has not received
    // yet has nothing there to update.
    const editable = canEdit && !openLead.convertedOrderId && Boolean(openLead.sync.hlc);
    return (
      <EditorScreen
        title={openLead.partyName}
        meta={
          <>
            {openLead.convertedOrderId && (
              <StatusPill tone="ok">{t('lead.badge.converted')}</StatusPill>
            )}
            {/* Provisional, with its temporary id, until the Master numbers it. */}
            <RecordNumber record={openLead} small />
          </>
        }
        actions={
          <>
            {onShareInChat && (
              <Button
                variant="secondary"
                size="sm"
                icon="chat"
                onClick={() => onShareInChat({ kind: 'lead', id: openLead.id })}
              >
                {t('chat.share.button')}
              </Button>
            )}
            {others}
            {editable && (
              <Button variant="secondary" size="sm" onClick={() => setEditingId(openLead.id)}>
                {t('lead.edit.action')}
              </Button>
            )}
            {/* Notes come from the local snapshot, so they need no Master and no
                sync; once converted, the final order carries them. */}
            {!openLead.convertedOrderId && (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setNote({ id: openLead.id, kind: 'filling' })}
                >
                  {t('orderNote.filling')}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setNote({ id: openLead.id, kind: 'dispatch' })}
                >
                  {t('orderNote.dispatch')}
                </Button>
              </>
            )}
            {/* The Master renders the PDF, so a lead it has not received yet
                has none to show. Opens beside the app (CATALOGUE_MODEL §8). */}
            {canPreviewPdf && openLead.sync.hlc && (
              <ButtonLink
                href={`/api/leads/${encodeURIComponent(openLead.id)}/pdf`}
                target="_blank"
                variant="secondary"
                size="sm"
              >
                {t('lead.previewPdf')}
              </ButtonLink>
            )}
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
      onError(caught instanceof Error ? caught.message : t('lead.error.move'));
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
      toast.push(
        t('lead.board.convertedToast', {
          qty: leadPieces(lead),
          orderId: recordNumberText({ id: result.id, poNumber: lead.poNumber }),
        }),
      );
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : t('lead.error.convert'));
    }
  }

  const columns: DataTableColumn<Lead>[] = [
    {
      key: 'id',
      header: t('lead.list.col.lead'),
      width: rem(190),
      render: (lead) => <RecordNumber record={lead} small />,
    },
    {
      key: 'viewing',
      header: t('presence.board.column'),
      // Wide enough for its uppercase header at 157 %, which at 76 ran into Party.
      width: rem(96),
      render: (lead) => (
        <AvatarStack
          entries={faces.get(lead.id) ?? []}
          selfUserId={userId}
          max={BOARD_SHOWN}
          size="xs"
        />
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
    {
      key: 'notes',
      header: t('orderNote.column.notes'),
      priority: 2,
      width: rem(220),
      render: (lead) =>
        lead.convertedOrderId ? null : (
          <NoteButtons
            onNote={(kind) => {
              setNote({ id: lead.id, kind });
              onOpenId(lead.id);
            }}
          />
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
          renderCard={(lead) => {
            // Local calendar day, YYYY-MM-DD, the shape `followUpDate` is stored in.
            const today = new Date().toLocaleDateString('en-CA');
            const pieces = leadPieces(lead);
            const colours = leadColours(lead);
            const mains = leadMains(lead);
            const stageIndex = stages.findIndex((stage) => stage.id === lead.stageId);
            const nextStage =
              stageIndex >= 0 && stageIndex < stages.length - 1 ? stages[stageIndex + 1] : null;
            const missingPackaging =
              packagingRequired && lead.items.some((item) => !item.packaging?.trim());
            return (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-6)' }}>
                  <span className="ob-boardcard__title">{lead.partyName}</span>
                  <span style={{ flex: 1 }} />
                  <AvatarStack
                    entries={faces.get(lead.id) ?? []}
                    selfUserId={userId}
                    max={BOARD_SHOWN}
                    size="xs"
                  />
                  {lead.incomplete && (
                    <StatusPill tone="conflict">{t('lead.badge.incomplete')}</StatusPill>
                  )}
                  <IconButton
                    icon="more"
                    label={t('lead.board.cardMenu')}
                    aria-haspopup="menu"
                    aria-expanded={menuId === lead.id}
                    // Enter/Space on the trigger belong to the trigger; the card's own key handler would open the record.
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
                    }}
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
                    <div className="ob-menu" role="menu">
                      <button
                        type="button"
                        role="menuitem"
                        className="ob-menu-item ob-body"
                        onClick={(event) => {
                          event.stopPropagation();
                          setMenuId(null);
                          onOpenId(lead.id);
                        }}
                      >
                        {t('lead.board.menu.open')}
                      </button>
                      {!lead.convertedOrderId &&
                        (['filling', 'dispatch'] as const).map((kind) => (
                          <button
                            key={kind}
                            type="button"
                            role="menuitem"
                        className="ob-menu-item ob-body"
                            onClick={(event) => {
                              event.stopPropagation();
                              setMenuId(null);
                              setNote({ id: lead.id, kind });
                              onOpenId(lead.id);
                            }}
                          >
                            {t(kind === 'filling' ? 'orderNote.filling' : 'orderNote.dispatch')}
                          </button>
                        ))}
                      {nextStage && (
                        <button
                          type="button"
                          role="menuitem"
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
                        role="menuitem"
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
                  }}
                >
                  {/* Provisional until the Master has acknowledged and numbered it. */}
                  <RecordNumber record={lead} small />
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
                    style={{ color: 'var(--fg-tertiary)' }}
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
                    }}
                  >
                    <span
                      style={{
                        display: 'inline-flex',
                        gap: 'var(--s-4)',
                        overflow: 'hidden',
                        flex: 1,
                        minWidth: 0,
                      }}
                    >
                      {colours.map((colour) => (
                        <ColourChip key={colour} name={colour} hex={colourHex(colour)} />
                      ))}
                    </span>
                  </div>
                )}

                <div style={{ display: 'flex', gap: 'var(--s-8)' }} className="ob-micro">
                  {lead.sourcePlatform && (
                    <span style={{ color: 'var(--fg-tertiary)' }}>
                      {t('lead.board.via', { source: lead.sourcePlatform })}
                    </span>
                  )}
                  <span style={{ flex: 1 }} />
                  {lead.followUpDate && (
                    // Amber once it is due (today or overdue), as on the Data artboard's card.
                    <span
                      style={{
                        color:
                          lead.followUpDate <= today ? 'var(--state-offline)' : 'var(--fg-tertiary)',
                      }}
                    >
                      {t('lead.detail.followUp')} {lead.followUpDate}
                    </span>
                  )}
                </div>
              </>
            );
          }}
        />
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={pagedLeads}
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
          <PageBar
            total={filtered.length}
            page={leadPage.page}
            pageSize={pageSize}
            onPage={(next) => setPaging({ key: pageKey, page: next })}
            onPageSize={setPageSize}
          />
        </>
      )}
    </>
  );
}
