/**
 * Notice board management (Oct 7, U5): the list of every notice, with a form to write one, an
 * audience picker, pin and "show until" controls, where else it shows (Basic Home, sign-in), who
 * has read each, and delete.
 *
 * Props in, callbacks out, like the reading view: the panel decides how a write reaches the Master.
 * A write that fails is thrown from its callback and shown here in the words the transport gave it;
 * a refused edit (somebody else saved first) is shown as a conflict with a Reload.
 *
 * Two tabs since 2026-10-08: **Notices**, and **Sell today**, the day's "what to sell" entries
 * (headline, message, the products to push, how long the pop-up stays, the days and the
 * audience). The second is offered only when the panel passes its writes, which it does when the
 * Master is new enough for them.
 */

import { useEffect, useState } from 'react';
import {
  NOTICE_BODY_MAX,
  NOTICE_TITLE_MAX,
  SELL_TODAY_AUTO_CLOSE_DEFAULT,
  SELL_TODAY_PRODUCTS_MAX,
  isNoticeExpired,
  sellTodayApplies,
  sellTodayFor,
  sellTodayProblem,
  sellTodayProductOf,
  noticeAtSignIn,
  noticeOnHome,
  noticeProblem,
  type Notice,
  type NoticeAudience,
  type NoticeInput,
  type NoticePriority,
  type NoticeProblem,
  type NoticeReaders,
  type NoticeUpdate,
  type Product,
  type SellToday,
  type SellTodayInput,
  type SellTodayProblem,
  type SellTodayProduct,
  type SellTodayUpdate,
} from '@orderbook/shared';

import { Button, IconButton } from './Button.js';
import { Combobox } from './Combobox.js';
import { useConfirm } from './ConfirmDialog.js';
import { StatusPill } from './DataDisplay.js';
import { DataTable, type DataTableColumn } from './DataTable.js';
import { apiErrorText } from './errorText.js';
import { formatDateTime } from './format.js';
import { Checkbox, DateField, FormField, Input, Textarea } from './Form.js';
import { t } from './i18n.js';
import { Modal } from './Modal.js';
import { ProductThumb } from './ProgressiveImage.js';
import { sellTodayCardLine } from './SellTodayPopup.js';
import { EmptyState, ErrorState, ConflictBanner, SkeletonRows } from './States.js';
import { Segmented, Tabs } from './Tabs.js';
import { useDebounced } from './useDebounced.js';

export interface NoticeRole {
  id: string;
  name: string;
}

export interface NoticeManageViewProps {
  notices: Notice[];
  /** The roles an audience can be made of. */
  roles: NoticeRole[];
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  onCreate: (input: NoticeInput) => Promise<void>;
  onUpdate: (id: string, update: NoticeUpdate) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  loadReaders: (id: string) => Promise<NoticeReaders>;
  /** Today as `YYYY-MM-DD`, for marking what has expired. */
  today?: string;
  /**
   * "Sell today" (2026-10-08). The tab is offered only with both writes: a panel whose Master is
   * too old for them leaves them out.
   */
  sellToday?: SellToday[];
  sellTodayError?: string | null;
  onCreateSellToday?: (input: SellTodayInput) => Promise<void>;
  onUpdateSellToday?: (id: string, update: SellTodayUpdate) => Promise<void>;
  /** The editor's product search (sub products, by name or code). */
  searchProducts?: (term: string) => Promise<Product[]>;
}

/** Pinned first, as on the board, then newest edit first: what a manager is most likely to want to touch. */
export function manageOrder(notices: readonly Notice[]): Notice[] {
  return [...notices].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;
  });
}

const isConflict = (caught: unknown): boolean => (caught as { code?: string } | null)?.code === 'conflict';

export function NoticeManageView({
  notices,
  roles,
  loading,
  error,
  onRetry,
  onCreate,
  onUpdate,
  onDelete,
  loadReaders,
  today,
  sellToday = [],
  sellTodayError,
  onCreateSellToday,
  onUpdateSellToday,
  searchProducts,
}: NoticeManageViewProps) {
  const confirm = useConfirm();
  const [tab, setTab] = useState<'notices' | 'sellToday'>('notices');
  const offersSellToday = Boolean(onCreateSellToday && onUpdateSellToday);
  const shownTab = offersSellToday ? tab : 'notices';
  const [editing, setEditing] = useState<Notice | 'new' | null>(null);
  const [readersOf, setReadersOf] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function act(id: string, action: () => Promise<void>): Promise<void> {
    setBusy(id);
    setActionError(null);
    try {
      await action();
    } catch (caught) {
      setActionError(apiErrorText(caught, 'notices.manage.actionFailed'));
    } finally {
      setBusy(null);
    }
  }

  async function remove(notice: Notice): Promise<void> {
    const sure = await confirm({
      title: t('notices.delete.title', { title: notice.title }),
      body: t('notices.delete.body'),
      confirmLabel: t('notices.delete.confirm'),
      tone: 'danger',
    });
    if (sure) await act(notice.id, () => onDelete(notice.id));
  }

  const columns: DataTableColumn<Notice>[] = [
    {
      key: 'notice',
      header: t('notices.manage.col.notice'),
      width: '2fr',
      render: (notice) => (
        // One line: a table row is one line tall, so the title gives way (its full text is the tooltip) and the
        // pills keep their size, instead of wrapping under the title into the next row.
        <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-6)', minWidth: 0, width: '100%' }}>
          <span
            className="ob-body-strong"
            title={notice.title}
            style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {notice.title}
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-4)', flex: 'none' }}>
            {notice.priority === 'important' && <StatusPill tone="conflict">{t('notices.priority.important')}</StatusPill>}
            {notice.pinned && <StatusPill tone="accent">{t('notices.pinned')}</StatusPill>}
            {(notice.expired || (today && isNoticeExpired(notice.showUntil, today))) && (
              <StatusPill tone="offline">{t('notices.expired')}</StatusPill>
            )}
          </span>
        </span>
      ),
    },
    {
      key: 'audience',
      header: t('notices.manage.col.audience'),
      width: '1.2fr',
      priority: 2,
      // A notice kept off Basic Home or off sign-in says so here, in one tag; one in both places (the
      // default) carries none. Not a column of its own: that came out of the title's room
      // (`fitColumns` counts a `fr` column as 120 px, so it never dropped), and a pinned important
      // notice's title was down to its first letters at 1280 px. Two tags on every row would cut
      // "Everyone" short here at 1280 px; one fits.
      render: (notice) => (
        <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-6)', minWidth: 0, width: '100%' }}>
          <span
            className="ob-small"
            title={audienceText(notice)}
            style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {audienceText(notice)}
          </span>
          {!noticeAtSignIn(notice) && <StatusPill>{t('notices.placement.homeOnlyTag')}</StatusPill>}
          {!noticeOnHome(notice) && <StatusPill>{t('notices.placement.signInOnlyTag')}</StatusPill>}
        </span>
      ),
    },
    {
      key: 'until',
      header: t('notices.manage.col.until'),
      width: '8rem',
      priority: 3,
      render: (notice) => <span className="ob-small">{notice.showUntil ?? t('notices.manage.noEnd')}</span>,
    },
    {
      key: 'reads',
      header: t('notices.manage.col.reads'),
      width: '6.5rem',
      priority: 2,
      render: (notice) => (
        <Button variant="ghost" size="sm" onClick={(event) => { event.stopPropagation(); setReadersOf(notice); }} aria-label={`${t('notices.manage.readers')}: ${notice.title}`}>
          {t('notices.manage.reads', { read: notice.readCount ?? 0, total: notice.audienceSize ?? 0 })}
        </Button>
      ),
    },
    {
      key: 'updated',
      header: t('notices.manage.col.updated'),
      width: '13rem',
      priority: 3,
      render: (notice) => (
        <span className="ob-small" style={{ whiteSpace: 'nowrap' }}>
          {formatDateTime(notice.updatedAt)}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      width: '14rem',
      render: (notice) => (
        // A click on an action is the action, not a click on the row (which opens the editor).
        <span
          style={{ display: 'flex', gap: 'var(--s-6)', justifyContent: 'flex-end', width: '100%' }}
          onClick={(event) => event.stopPropagation()}
        >
          <Button
            variant="ghost"
            size="sm"
            disabled={busy !== null}
            onClick={() => void act(notice.id, () => onUpdate(notice.id, { pinned: !notice.pinned, expectedVersion: notice.version }))}
          >
            {notice.pinned ? t('notices.manage.unpin') : t('notices.manage.pin')}
          </Button>
          <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => setEditing(notice)}>
            {t('notices.manage.edit')}
          </Button>
          <Button variant="danger" size="sm" disabled={busy !== null} onClick={() => void remove(notice)}>
            {t('notices.manage.delete')}
          </Button>
        </span>
      ),
    },
  ];

  const tabs = offersSellToday ? (
    <Tabs
      tabs={[
        { id: 'notices', label: t('notices.manage.tab.notices'), count: notices.length },
        { id: 'sellToday', label: t('notices.manage.tab.sellToday'), count: sellToday.length },
      ]}
      activeId={shownTab}
      onChange={(id) => setTab(id as 'notices' | 'sellToday')}
    />
  ) : null;

  if (shownTab === 'sellToday' && onCreateSellToday && onUpdateSellToday) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-12)' }}>
        {tabs}
        <SellTodayPanel
          entries={sellToday}
          roles={roles}
          loading={loading}
          error={sellTodayError ?? null}
          onRetry={onRetry}
          today={today}
          onCreate={onCreateSellToday}
          onUpdate={onUpdateSellToday}
          onDelete={onDelete}
          searchProducts={searchProducts}
        />
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-12)' }}>
      {tabs}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>
          {t('notices.manage.new')}
        </Button>
      </div>

      {actionError && <ConflictBanner>{actionError}</ConflictBanner>}

      {loading && notices.length === 0 ? (
        <SkeletonRows rows={5} columns={4} />
      ) : error && notices.length === 0 ? (
        <ErrorState title={t('notices.manage.loadFailed')} description={error} actionLabel={onRetry ? t('action.retryNow') : undefined} onAction={onRetry} />
      ) : (
        <DataTable
          columns={columns}
          rows={manageOrder(notices)}
          rowKey={(notice) => notice.id}
          // A row opens the editor, like every other list. That also lets the table drop its less important
          // columns (audience, end date, readers, updated) before it would clip an action.
          onRowOpen={(notice) => setEditing(notice)}
          empty={
            <EmptyState
              title={t('notices.manage.empty')}
              description={t('notices.manage.emptyBody')}
              actionLabel={t('notices.manage.new')}
              onAction={() => setEditing('new')}
            />
          }
        />
      )}

      {editing && (
        <NoticeEditor
          key={editing === 'new' ? 'new' : editing.id}
          notice={editing === 'new' ? null : editing}
          roles={roles}
          onClose={() => setEditing(null)}
          onReload={onRetry}
          onSave={async (input) => {
            if (editing === 'new') await onCreate(input);
            else await onUpdate(editing.id, { ...input, expectedVersion: editing.version });
            setEditing(null);
          }}
        />
      )}

      {readersOf && <NoticeReadersDialog notice={readersOf} loadReaders={loadReaders} onClose={() => setReadersOf(null)} />}
    </div>
  );
}

function audienceText(notice: Pick<Notice, 'audience' | 'audienceRoleNames'>): string {
  if (notice.audience.kind === 'all') return t('notices.manage.audienceAll');
  const names = notice.audienceRoleNames?.length ? notice.audienceRoleNames : notice.audience.roleIds;
  return t('notices.manage.audienceRoles', { roles: names.join(', ') });
}

function NoticeEditor({
  notice,
  roles,
  onClose,
  onSave,
  onReload,
}: {
  notice: Notice | null;
  roles: NoticeRole[];
  onClose: () => void;
  onSave: (input: NoticeInput) => Promise<void>;
  onReload?: () => void;
}) {
  const [title, setTitle] = useState(notice?.title ?? '');
  const [body, setBody] = useState(notice?.body ?? '');
  const [priority, setPriority] = useState<NoticePriority>(notice?.priority ?? 'normal');
  const [pinned, setPinned] = useState(notice?.pinned ?? false);
  const [showUntil, setShowUntil] = useState(notice?.showUntil ?? '');
  const [showOnHome, setShowOnHome] = useState(notice ? noticeOnHome(notice) : true);
  const [showAtSignIn, setShowAtSignIn] = useState(notice ? noticeAtSignIn(notice) : true);
  const [audienceKind, setAudienceKind] = useState<'all' | 'roles'>(notice?.audience.kind ?? 'all');
  const [roleIds, setRoleIds] = useState<string[]>(notice?.audience.kind === 'roles' ? notice.audience.roleIds : []);
  const [problem, setProblem] = useState<NoticeProblem | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);

  const audience: NoticeAudience = audienceKind === 'all' ? { kind: 'all' } : { kind: 'roles', roleIds };

  async function submit(): Promise<void> {
    const input: NoticeInput = {
      title: title.trim(),
      body,
      priority,
      pinned,
      showUntil: showUntil || null,
      showOnHome,
      showAtSignIn,
      audience,
    };
    const found = noticeProblem(input, 'create');
    setProblem(found);
    if (found) return;
    setSaving(true);
    setFailure(null);
    setConflict(false);
    try {
      await onSave(input);
    } catch (caught) {
      if (isConflict(caught)) setConflict(true);
      else setFailure(apiErrorText(caught, 'notices.editor.saveFailed'));
      setSaving(false);
    }
  }

  const problemFor = (...these: NoticeProblem[]): string | undefined =>
    problem && these.includes(problem) ? t(`notices.problem.${problem}`) : undefined;

  return (
    <Modal
      open
      onClose={saving ? () => undefined : onClose}
      title={notice ? t('notices.editor.editTitle') : t('notices.editor.newTitle')}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t('notices.editor.cancel')}
          </Button>
          <Button variant="primary" busy={saving} onClick={() => void submit()}>
            {t('notices.editor.save')}
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
        {conflict && (
          <ConflictBanner
            action={
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  onReload?.();
                  onClose();
                }}
              >
                {t('notices.editor.reload')}
              </Button>
            }
          >
            {t('notices.editor.conflict')}
          </ConflictBanner>
        )}
        {failure && <ConflictBanner>{failure}</ConflictBanner>}

        <FormField label={t('notices.editor.titleLabel')} required error={problemFor('title_required', 'title_too_long')}>
          {(id) => (
            <Input
              id={id}
              value={title}
              maxLength={NOTICE_TITLE_MAX + 20}
              autoFocus
              invalid={Boolean(problemFor('title_required', 'title_too_long'))}
              onChange={(event) => setTitle(event.target.value)}
            />
          )}
        </FormField>

        <FormField
          label={`${t('notices.editor.bodyLabel')} · ${t('notices.editor.counter', { count: body.length, max: NOTICE_BODY_MAX })}`}
          hint={t('notices.editor.bodyHint')}
          error={problemFor('body_too_long')}
        >
          {(id) => (
            <Textarea
              id={id}
              value={body}
              rows={8}
              invalid={Boolean(problemFor('body_too_long'))}
              onChange={(event) => setBody(event.target.value)}
            />
          )}
        </FormField>

        <FormField label={t('notices.editor.priorityLabel')}>
          {() => (
            <Segmented<NoticePriority>
              label={t('notices.editor.priorityLabel')}
              options={[
                { value: 'normal', label: t('notices.priority.normal') },
                { value: 'important', label: t('notices.priority.important') },
              ]}
              value={priority}
              onChange={setPriority}
            />
          )}
        </FormField>

        <Checkbox checked={pinned} onChange={setPinned} label={t('notices.editor.pinned')} />

        <FormField
          label={t('notices.editor.placementLabel')}
          hint={t('notices.editor.placementHint')}
          error={problemFor('no_placement')}
        >
          {() => (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
              <Checkbox checked={showOnHome} onChange={setShowOnHome} label={t('notices.placement.home')} />
              <Checkbox checked={showAtSignIn} onChange={setShowAtSignIn} label={t('notices.placement.signIn')} />
            </div>
          )}
        </FormField>

        <FormField label={t('notices.editor.untilLabel')} hint={t('notices.editor.untilHint')} error={problemFor('bad_date')}>
          {(id) => (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-8)' }}>
              <DateField id={id} value={showUntil} onChange={(event) => setShowUntil(event.target.value)} />
              {showUntil && (
                <Button variant="ghost" size="sm" onClick={() => setShowUntil('')}>
                  {t('notices.editor.clearDate')}
                </Button>
              )}
            </span>
          )}
        </FormField>

        <AudienceField
          roles={roles}
          kind={audienceKind}
          onKind={setAudienceKind}
          roleIds={roleIds}
          onRoleIds={setRoleIds}
          error={problemFor('audience_empty', 'audience_too_big')}
        />
      </div>
    </Modal>
  );
}

/** Who a notice or a "Sell today" entry is for: everybody, or the roles ticked. */
function AudienceField({
  roles,
  kind,
  onKind,
  roleIds,
  onRoleIds,
  error,
}: {
  roles: NoticeRole[];
  kind: 'all' | 'roles';
  onKind: (kind: 'all' | 'roles') => void;
  roleIds: string[];
  onRoleIds: (update: (current: string[]) => string[]) => void;
  error?: string;
}) {
  return (
    <FormField label={t('notices.editor.audienceLabel')} error={error}>
      {() => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-8)' }}>
          <Segmented<'all' | 'roles'>
            label={t('notices.editor.audienceLabel')}
            options={[
              { value: 'all', label: t('notices.editor.audienceAll') },
              { value: 'roles', label: t('notices.editor.audienceRoles') },
            ]}
            value={kind}
            onChange={onKind}
          />
          {kind === 'roles' &&
            (roles.length === 0 ? (
              <span className="ob-small">{t('notices.editor.noRoles')}</span>
            ) : (
              <fieldset style={{ border: 0, margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
                <legend className="ob-small" style={{ color: 'var(--fg-secondary)', padding: 0, marginBottom: 'var(--s-4)' }}>
                  {t('notices.editor.rolesHint')}
                </legend>
                {roles.map((role) => (
                  <Checkbox
                    key={role.id}
                    checked={roleIds.includes(role.id)}
                    label={role.name}
                    onChange={(checked) =>
                      onRoleIds((current) => (checked ? [...current, role.id] : current.filter((id) => id !== role.id)))
                    }
                  />
                ))}
              </fieldset>
            ))}
        </div>
      )}
    </FormField>
  );
}

function NoticeReadersDialog({
  notice,
  loadReaders,
  onClose,
}: {
  notice: Notice;
  loadReaders: (id: string) => Promise<NoticeReaders>;
  onClose: () => void;
}) {
  const [readers, setReaders] = useState<NoticeReaders | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    loadReaders(notice.id)
      .then((answer) => live && setReaders(answer))
      .catch((caught) => live && setFailure(apiErrorText(caught, 'notices.readers.failed')));
    return () => {
      live = false;
    };
    // The loader is the panel's; the dialog asks once for the notice it was opened on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notice.id]);

  const read = readers?.readers.filter((reader) => reader.readAt !== null).length ?? 0;

  return (
    <Modal
      open
      onClose={onClose}
      title={t('notices.readers.title', { title: notice.title })}
      size="md"
      footer={
        <Button variant="secondary" onClick={onClose}>
          {t('notices.readers.close')}
        </Button>
      }
    >
      {failure ? (
        <ConflictBanner>{failure}</ConflictBanner>
      ) : !readers ? (
        <SkeletonRows rows={4} columns={2} />
      ) : readers.readers.length === 0 ? (
        <EmptyState title={t('notices.readers.empty')} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-8)' }}>
          <span className="ob-body-strong" role="status">
            {t('notices.readers.summary', { read, total: readers.readers.length })}
          </span>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
            {readers.readers.map((reader) => (
              <li
                key={reader.userId}
                data-user={reader.userId}
                style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--s-12)', padding: 'var(--s-4) 0', borderBottom: '1px solid var(--line)' }}
              >
                <span style={{ overflowWrap: 'anywhere' }}>{reader.displayName}</span>
                <span className="ob-small" style={{ color: reader.readAt ? 'var(--fg-secondary)' : 'var(--fg-tertiary)' }}>
                  {reader.readAt ? t('notices.readers.read', { when: formatDateTime(reader.readAt) }) : t('notices.readers.unread')}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Modal>
  );
}

// --- Sell today (2026-10-08) -----------------------------------------------------------------

type SellTodayStatus = 'today' | 'superseded' | 'upcoming' | 'ended';

/** Where an entry stands on `today`: the one showing, one a newer entry covers, not started, ended. */
export function sellTodayStatus(entry: SellToday, entries: readonly SellToday[], today: string): SellTodayStatus {
  if (entry.expired || isNoticeExpired(entry.showUntil, today)) return 'ended';
  if (!sellTodayApplies(entry, today)) return 'upcoming';
  return sellTodayFor(entries, today)?.id === entry.id ? 'today' : 'superseded';
}

const STATUS_TONE = { today: 'ok', superseded: 'offline', upcoming: 'accent', ended: 'offline' } as const;

function daysText(entry: SellToday): string {
  const from = entry.showFrom ?? entry.createdAt.slice(0, 10);
  if (entry.showUntil === null) return t('sellToday.days.open', { from });
  return entry.showUntil === from ? from : t('sellToday.days.range', { from, to: entry.showUntil });
}

function closesText(seconds: number): string {
  return seconds > 0 ? t('sellToday.closes.after', { seconds }) : t('sellToday.closes.never');
}

/** A product's small square, from a card's own photo. */
function CardThumb({ product, size }: { product: SellTodayProduct; size?: 32 | 48 }) {
  return (
    <ProductThumb images={product.image ? [product.image] : []} name={product.name} size={size} fallback="initial" alt="" />
  );
}

function SellTodayPanel({
  entries,
  roles,
  loading,
  error,
  onRetry,
  today,
  onCreate,
  onUpdate,
  onDelete,
  searchProducts,
}: {
  entries: SellToday[];
  roles: NoticeRole[];
  loading?: boolean;
  error: string | null;
  onRetry?: () => void;
  today?: string;
  onCreate: (input: SellTodayInput) => Promise<void>;
  onUpdate: (id: string, update: SellTodayUpdate) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  searchProducts?: (term: string) => Promise<Product[]>;
}) {
  const confirm = useConfirm();
  const [editing, setEditing] = useState<SellToday | 'new' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const day = today ?? new Date().toISOString().slice(0, 10);

  async function remove(entry: SellToday): Promise<void> {
    const sure = await confirm({
      title: t('sellToday.delete.title', { title: entry.title }),
      body: t('sellToday.delete.body'),
      confirmLabel: t('sellToday.delete.confirm'),
      tone: 'danger',
    });
    if (!sure) return;
    setBusy(entry.id);
    setActionError(null);
    try {
      await onDelete(entry.id);
    } catch (caught) {
      setActionError(apiErrorText(caught, 'notices.manage.actionFailed'));
    } finally {
      setBusy(null);
    }
  }

  const columns: DataTableColumn<SellToday>[] = [
    {
      key: 'entry',
      header: t('sellToday.manage.col.entry'),
      width: '2fr',
      render: (entry) => {
        const status = sellTodayStatus(entry, entries, day);
        return (
          <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-6)', minWidth: 0, width: '100%' }}>
            <span
              className="ob-body-strong"
              title={entry.title}
              style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {entry.title}
            </span>
            <span style={{ flex: 'none' }} data-status={status}>
              <StatusPill tone={STATUS_TONE[status]}>{t(`sellToday.status.${status}`)}</StatusPill>
            </span>
          </span>
        );
      },
    },
    {
      key: 'products',
      header: t('sellToday.manage.col.products'),
      width: '1.4fr',
      priority: 2,
      render: (entry) =>
        entry.productIds.length === 0 ? (
          <span className="ob-small">{t('sellToday.manage.messageOnly')}</span>
        ) : (
          <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-4)', minWidth: 0 }}>
            {entry.products.slice(0, 4).map((product) => (
              <CardThumb key={product.id} product={product} />
            ))}
            <span className="ob-small" style={{ marginLeft: 'var(--s-4)', whiteSpace: 'nowrap' }}>
              {t('sellToday.manage.productCount', { count: entry.productIds.length })}
            </span>
          </span>
        ),
    },
    {
      key: 'days',
      header: t('sellToday.manage.col.days'),
      width: '11rem',
      priority: 2,
      render: (entry) => <span className="ob-small" style={{ whiteSpace: 'nowrap' }}>{daysText(entry)}</span>,
    },
    {
      key: 'audience',
      header: t('notices.manage.col.audience'),
      width: '1fr',
      priority: 3,
      render: (entry) => (
        <span className="ob-small" title={audienceText(entry)} style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {audienceText(entry)}
        </span>
      ),
    },
    {
      key: 'closes',
      header: t('sellToday.manage.col.closes'),
      width: '7.5rem',
      priority: 3,
      render: (entry) => <span className="ob-small" style={{ whiteSpace: 'nowrap' }}>{closesText(entry.autoCloseSeconds)}</span>,
    },
    {
      key: 'actions',
      header: '',
      width: '10rem',
      render: (entry) => (
        <span
          style={{ display: 'flex', gap: 'var(--s-6)', justifyContent: 'flex-end', width: '100%' }}
          onClick={(event) => event.stopPropagation()}
        >
          <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => setEditing(entry)}>
            {t('notices.manage.edit')}
          </Button>
          <Button variant="danger" size="sm" disabled={busy !== null} onClick={() => void remove(entry)}>
            {t('notices.manage.delete')}
          </Button>
        </span>
      ),
    },
  ];

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--s-16)' }}>
        <p className="ob-small" style={{ margin: 0 }}>
          {t('sellToday.manage.intro')}
        </p>
        <Button variant="primary" icon="plus" onClick={() => setEditing('new')} style={{ flex: 'none' }}>
          {t('sellToday.manage.new')}
        </Button>
      </div>

      {actionError && <ConflictBanner>{actionError}</ConflictBanner>}

      {loading && entries.length === 0 ? (
        <SkeletonRows rows={3} columns={4} />
      ) : error && entries.length === 0 ? (
        <ErrorState
          title={t('sellToday.manage.loadFailed')}
          description={error}
          actionLabel={onRetry ? t('action.retryNow') : undefined}
          onAction={onRetry}
        />
      ) : (
        <DataTable
          columns={columns}
          rows={entries}
          rowKey={(entry) => entry.id}
          onRowOpen={(entry) => setEditing(entry)}
          empty={
            <EmptyState
              title={t('sellToday.manage.empty')}
              description={t('sellToday.manage.emptyBody')}
              actionLabel={t('sellToday.manage.new')}
              onAction={() => setEditing('new')}
            />
          }
        />
      )}

      {editing && (
        <SellTodayEditor
          key={editing === 'new' ? 'new' : editing.id}
          entry={editing === 'new' ? null : editing}
          roles={roles}
          today={day}
          searchProducts={searchProducts}
          onClose={() => setEditing(null)}
          onReload={onRetry}
          onSave={async (input) => {
            if (editing === 'new') await onCreate(input);
            else await onUpdate(editing.id, { ...input, expectedVersion: editing.version });
            setEditing(null);
          }}
        />
      )}
    </>
  );
}

/** "Close by itself after": never, or one of these. The Master takes any whole 5 to 120. */
const AUTO_CLOSE_CHOICES = [0, 5, 10, 15, 20, 30, 45, 60, 90, 120] as const;

function SellTodayEditor({
  entry,
  roles,
  today,
  searchProducts,
  onClose,
  onSave,
  onReload,
}: {
  entry: SellToday | null;
  roles: NoticeRole[];
  today: string;
  searchProducts?: (term: string) => Promise<Product[]>;
  onClose: () => void;
  onSave: (input: SellTodayInput) => Promise<void>;
  onReload?: () => void;
}) {
  const [title, setTitle] = useState(entry?.title ?? '');
  const [body, setBody] = useState(entry?.body ?? '');
  const [picked, setPicked] = useState<SellTodayProduct[]>(entry?.products ?? []);
  const [autoClose, setAutoClose] = useState<number>(entry?.autoCloseSeconds ?? SELL_TODAY_AUTO_CLOSE_DEFAULT);
  // A new entry is for today only; an edit keeps its own days.
  const [showFrom, setShowFrom] = useState(entry ? (entry.showFrom ?? '') : today);
  const [showUntil, setShowUntil] = useState(entry ? (entry.showUntil ?? '') : today);
  const [audienceKind, setAudienceKind] = useState<'all' | 'roles'>(entry?.audience.kind ?? 'all');
  const [roleIds, setRoleIds] = useState<string[]>(entry?.audience.kind === 'roles' ? entry.audience.roleIds : []);
  const [problem, setProblem] = useState<SellTodayProblem | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);

  const [query, setQuery] = useState('');
  const term = useDebounced(query);
  const [results, setResults] = useState<Product[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);

  useEffect(() => {
    if (!searchProducts) return undefined;
    let live = true;
    setSearching(true);
    searchProducts(term.trim())
      .then((found) => {
        if (!live) return;
        setResults(found);
        setSearchFailed(false);
      })
      .catch(() => live && setSearchFailed(true))
      .finally(() => live && setSearching(false));
    return () => {
      live = false;
    };
    // The search is the panel's; it runs for the term typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term]);

  const full = picked.length >= SELL_TODAY_PRODUCTS_MAX;
  const pickedIds = new Set(picked.map((product) => product.id));
  const options = results
    .filter((product) => product.isActive && !pickedIds.has(product.id))
    .map((product) => {
      const card = sellTodayProductOf(product);
      return {
        key: product.id,
        label: product.name,
        hint: sellTodayCardLine(card, true),
        value: card,
        leading: <CardThumb product={card} />,
      };
    });

  async function submit(): Promise<void> {
    const input: SellTodayInput = {
      title: title.trim(),
      body,
      productIds: picked.map((product) => product.id),
      autoCloseSeconds: autoClose,
      showFrom: showFrom || null,
      showUntil: showUntil || null,
      audience: audienceKind === 'all' ? { kind: 'all' } : { kind: 'roles', roleIds },
    };
    const found = sellTodayProblem(input, 'create');
    setProblem(found);
    if (found) return;
    setSaving(true);
    setFailure(null);
    setConflict(false);
    try {
      await onSave(input);
    } catch (caught) {
      if (isConflict(caught)) setConflict(true);
      else setFailure(apiErrorText(caught, 'sellToday.editor.saveFailed'));
      setSaving(false);
    }
  }

  const problemFor = (...these: SellTodayProblem[]): string | undefined =>
    problem && these.includes(problem) ? t(`sellToday.problem.${problem}`) : undefined;

  return (
    <Modal
      open
      onClose={saving ? () => undefined : onClose}
      title={entry ? t('sellToday.editor.editTitle') : t('sellToday.editor.newTitle')}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t('notices.editor.cancel')}
          </Button>
          <Button variant="primary" busy={saving} onClick={() => void submit()}>
            {t('sellToday.editor.save')}
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
        {conflict && (
          <ConflictBanner
            action={
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  onReload?.();
                  onClose();
                }}
              >
                {t('notices.editor.reload')}
              </Button>
            }
          >
            {t('sellToday.editor.conflict')}
          </ConflictBanner>
        )}
        {failure && <ConflictBanner>{failure}</ConflictBanner>}

        <FormField label={t('sellToday.editor.titleLabel')} required error={problemFor('title_required', 'title_too_long')}>
          {(id) => (
            <Input
              id={id}
              value={title}
              maxLength={NOTICE_TITLE_MAX + 20}
              autoFocus
              placeholder={t('sellToday.editor.titlePlaceholder')}
              invalid={Boolean(problemFor('title_required', 'title_too_long'))}
              onChange={(event) => setTitle(event.target.value)}
            />
          )}
        </FormField>

        <FormField
          label={t('sellToday.editor.productsLabel')}
          hint={t('sellToday.editor.productsHint', { max: SELL_TODAY_PRODUCTS_MAX })}
          error={problemFor('nothing_to_sell', 'too_many_products')}
        >
          {() => (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-8)' }}>
              {searchProducts && (
                <Combobox<SellTodayProduct>
                  ariaLabel={t('sellToday.editor.searchLabel')}
                  placeholder={full ? t('sellToday.editor.full') : t('sellToday.editor.searchPlaceholder')}
                  options={options}
                  filter={false}
                  loading={searching}
                  disabled={full}
                  onQueryChange={setQuery}
                  emptyLabel={searchFailed ? t('sellToday.editor.searchFailed') : t('sellToday.editor.searchEmpty')}
                  onSelect={(option) =>
                    setPicked((current) =>
                      current.length >= SELL_TODAY_PRODUCTS_MAX || current.some((each) => each.id === option.value.id)
                        ? current
                        : [...current, option.value],
                    )
                  }
                />
              )}
              {picked.length === 0 ? (
                <span className="ob-small">{t('sellToday.editor.noProducts')}</span>
              ) : (
                <ol className="ob-selltoday-picked">
                  {picked.map((product) => (
                    <li key={product.id} data-product={product.id}>
                      <CardThumb product={product} size={32} />
                      <span className="ob-selltoday-picked-text">
                        <span className="ob-body-strong">{product.name}</span>
                        <span className="ob-small">
                          {sellTodayCardLine(product, true)}
                        </span>
                      </span>
                      <IconButton
                        icon="close"
                        label={t('sellToday.editor.remove', { name: product.name })}
                        onClick={() => setPicked((current) => current.filter((each) => each.id !== product.id))}
                      />
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}
        </FormField>

        <FormField
          label={`${t('sellToday.editor.bodyLabel')} · ${t('notices.editor.counter', { count: body.length, max: NOTICE_BODY_MAX })}`}
          hint={t('sellToday.editor.bodyHint')}
          error={problemFor('body_too_long')}
        >
          {(id) => (
            <Textarea
              id={id}
              value={body}
              rows={3}
              invalid={Boolean(problemFor('body_too_long'))}
              onChange={(event) => setBody(event.target.value)}
            />
          )}
        </FormField>

        <div className="ob-selltoday-row">
          <FormField label={t('sellToday.editor.autoCloseLabel')} hint={t('sellToday.editor.autoCloseHint')} error={problemFor('bad_auto_close')}>
            {(id) => (
              <select id={id} className="ob-select" value={autoClose} onChange={(event) => setAutoClose(Number(event.target.value))}>
                {[...new Set<number>([...AUTO_CLOSE_CHOICES, autoClose])]
                  .sort((a, b) => a - b)
                  .map((seconds) => (
                    <option key={seconds} value={seconds}>
                      {seconds === 0 ? t('sellToday.editor.autoCloseNever') : t('sellToday.editor.seconds', { seconds })}
                    </option>
                  ))}
              </select>
            )}
          </FormField>
          <FormField label={t('sellToday.editor.fromLabel')} error={problemFor('bad_date')}>
            {(id) => <DateField id={id} value={showFrom} onChange={(event) => setShowFrom(event.target.value)} />}
          </FormField>
          <FormField label={t('sellToday.editor.untilLabel')} error={problemFor('dates_reversed')}>
            {(id) => <DateField id={id} value={showUntil} onChange={(event) => setShowUntil(event.target.value)} />}
          </FormField>
        </div>
        <p className="ob-small" style={{ margin: 'calc(-1 * var(--s-8)) 0 0' }}>
          {t('sellToday.editor.daysHint')}
        </p>

        <AudienceField
          roles={roles}
          kind={audienceKind}
          onKind={setAudienceKind}
          roleIds={roleIds}
          onRoleIds={setRoleIds}
          error={problemFor('audience_empty', 'audience_too_big')}
        />
      </div>
    </Modal>
  );
}
