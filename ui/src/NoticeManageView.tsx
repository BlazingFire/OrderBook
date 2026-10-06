/**
 * Notice board management (Oct 7, U5): the list of every notice, with a form to write one, an
 * audience picker, pin and "show until" controls, who has read each, and delete.
 *
 * Props in, callbacks out, like the reading view: the panel decides how a write reaches the Master.
 * A write that fails is thrown from its callback and shown here in the words the transport gave it;
 * a refused edit (somebody else saved first) is shown as a conflict with a Reload.
 */

import { useEffect, useState } from 'react';
import {
  NOTICE_BODY_MAX,
  NOTICE_TITLE_MAX,
  isNoticeExpired,
  noticeProblem,
  type Notice,
  type NoticeAudience,
  type NoticeInput,
  type NoticePriority,
  type NoticeProblem,
  type NoticeReaders,
  type NoticeUpdate,
} from '@orderbook/shared';

import { Button } from './Button.js';
import { useConfirm } from './ConfirmDialog.js';
import { StatusPill } from './DataDisplay.js';
import { DataTable, type DataTableColumn } from './DataTable.js';
import { apiErrorText } from './errorText.js';
import { formatDateTime } from './format.js';
import { Checkbox, DateField, FormField, Input, Textarea } from './Form.js';
import { t } from './i18n.js';
import { Modal } from './Modal.js';
import { EmptyState, ErrorState, ConflictBanner, SkeletonRows } from './States.js';
import { Segmented } from './Tabs.js';

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
}

/** Newest edit first: what a manager is most likely to want to touch. */
export function manageOrder(notices: readonly Notice[]): Notice[] {
  return [...notices].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
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
}: NoticeManageViewProps) {
  const confirm = useConfirm();
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
        <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-6)', flexWrap: 'wrap', minWidth: 0 }}>
          <span className="ob-body-strong" title={notice.title} style={{ overflowWrap: 'anywhere' }}>
            {notice.title}
          </span>
          {notice.priority === 'important' && <StatusPill tone="conflict">{t('notices.priority.important')}</StatusPill>}
          {notice.pinned && <StatusPill tone="accent">{t('notices.pinned')}</StatusPill>}
          {(notice.expired || (today && isNoticeExpired(notice.showUntil, today))) && (
            <StatusPill tone="offline">{t('notices.expired')}</StatusPill>
          )}
        </span>
      ),
    },
    {
      key: 'audience',
      header: t('notices.manage.col.audience'),
      width: '1.2fr',
      render: (notice) => (
        <span className="ob-small" title={audienceText(notice)} style={{ overflowWrap: 'anywhere' }}>
          {audienceText(notice)}
        </span>
      ),
    },
    {
      key: 'until',
      header: t('notices.manage.col.until'),
      width: '8rem',
      render: (notice) => <span className="ob-small">{notice.showUntil ?? t('notices.manage.noEnd')}</span>,
    },
    {
      key: 'reads',
      header: t('notices.manage.col.reads'),
      width: '7rem',
      render: (notice) => (
        <Button variant="ghost" size="sm" onClick={() => setReadersOf(notice)} aria-label={`${t('notices.manage.readers')}: ${notice.title}`}>
          {t('notices.manage.reads', { read: notice.readCount ?? 0, total: notice.audienceSize ?? 0 })}
        </Button>
      ),
    },
    {
      key: 'updated',
      header: t('notices.manage.col.updated'),
      width: '11rem',
      render: (notice) => <span className="ob-small">{formatDateTime(notice.updatedAt)}</span>,
    },
    {
      key: 'actions',
      header: '',
      width: '16rem',
      render: (notice) => (
        <span style={{ display: 'flex', gap: 'var(--s-6)', justifyContent: 'flex-end', width: '100%' }}>
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-12)' }}>
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

function audienceText(notice: Notice): string {
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
          label={t('notices.editor.bodyLabel')}
          hint={`${t('notices.editor.bodyHint')} ${t('notices.editor.counter', { count: body.length, max: NOTICE_BODY_MAX })}`}
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

        <FormField label={t('notices.editor.audienceLabel')} error={problemFor('audience_empty', 'audience_too_big')}>
          {() => (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-8)' }}>
              <Segmented<'all' | 'roles'>
                label={t('notices.editor.audienceLabel')}
                options={[
                  { value: 'all', label: t('notices.editor.audienceAll') },
                  { value: 'roles', label: t('notices.editor.audienceRoles') },
                ]}
                value={audienceKind}
                onChange={setAudienceKind}
              />
              {audienceKind === 'roles' &&
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
                          setRoleIds((current) => (checked ? [...current, role.id] : current.filter((id) => id !== role.id)))
                        }
                      />
                    ))}
                  </fieldset>
                ))}
            </div>
          )}
        </FormField>
      </div>
    </Modal>
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
