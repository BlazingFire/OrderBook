/**
 * Documents — PDF templates and the export history
 * (docs/backend-modules/04-API-CONTRACT.md §6).
 *
 * Two tabs because they are two different kinds of record, not two views of
 * one: a template is editable and recyclable, an export is neither. A document
 * that went to a customer is the evidence of what was sent, so nothing here
 * offers to delete one — the only action on an export is fetching the same
 * bytes back.
 *
 * The editor is a form, not a page designer. `layout` (block order and
 * per-block options) is carried through a save untouched: it is prefilled from
 * `TEMPLATE_DEFAULTS` when a template is created and never re-derived
 * afterwards, so a future designer can own that field without this screen
 * having quietly rewritten it in the meantime.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  DocumentExport,
  DocumentTemplate,
  DocumentTemplateInput,
  DocumentSubjectKind,
  DocumentType,
  PageOrientation,
  PaperSize,
} from '@orderbook/shared';
import {
  DOCUMENT_TYPES,
  MAX_TERMS_LENGTH,
  PAGE_ORIENTATIONS,
  PAPER_SIZES,
  TEMPLATE_DEFAULTS,
} from '@orderbook/shared';

import { api, ApiError, type FieldDifference } from '../api';
import {
  Button,
  ButtonLink,
  Card,
  ConflictBanner,
  DataTable,
  EmptyState,
  ErrorState,
  FormField,
  Input,
  LoadMorePager,
  Modal,
  NumberInput,
  Section,
  Select,
  SkeletonTable,
  StatusPill,
  Switch,
  Tabs,
  Textarea,
  formatBytes,
  formatDateTime,
  rem,
  t,
  useToast,
  type DataTableColumn,
  type TabItem,
} from '@orderbook/ui';

interface Props {
  revision: number;
  /** The signed-in caller's own resolved permissions. */
  permissions: string[];
}

type Tab = 'templates' | 'exports';

const DOCUMENT_TYPE_KEY: Record<DocumentType, string> = {
  quotation: 'documents.type.quotation',
  order_confirmation: 'documents.type.orderConfirmation',
  dispatch_note: 'documents.type.dispatchNote',
};

/** A subject the preview can be rendered against — a real lead or order. */
interface PreviewSubject {
  kind: DocumentSubjectKind;
  id: string;
  label: string;
}

/** One `<option>` value has to identify both halves `/preview` asks for. */
const subjectKey = (subject: PreviewSubject) => `${subject.kind}:${subject.id}`;

export function DocumentsScreen({ revision, permissions }: Props) {
  const [tab, setTab] = useState<Tab>('templates');
  const can = (key: string) => permissions.includes(key);

  // The whole screen is behind `documents.view`; without it there is no partial
  // version worth rendering, since both tabs read from guarded endpoints.
  if (!can('documents.view')) {
    return (
      <EmptyState
        title={t('documents.noAccess.title')}
        description={t('documents.noAccess.description', { permission: 'documents.view' })}
      />
    );
  }

  const tabs: TabItem[] = [
    { id: 'templates', label: t('documents.tab.templates') },
    { id: 'exports', label: t('documents.tab.exports') },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h1 className="ob-title" style={{ margin: 0 }}>
          {t('documents.title')}
        </h1>
        <Tabs tabs={tabs} activeId={tab} onChange={(id) => setTab(id as Tab)} />
      </div>

      {tab === 'templates' ? (
        <TemplatesTab
          revision={revision}
          canCreate={can('documents.create')}
          canEdit={can('documents.edit')}
          canDelete={can('documents.delete')}
          canRender={can('documents.render')}
        />
      ) : (
        <ExportsTab revision={revision} />
      )}
    </div>
  );
}

// --- Templates --------------------------------------------------------------

function TemplatesTab({
  revision,
  canCreate,
  canEdit,
  canDelete,
  canRender,
}: {
  revision: number;
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canRender: boolean;
}) {
  const toast = useToast();
  const [templates, setTemplates] = useState<DocumentTemplate[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [paging, setPaging] = useState(false);
  // Kept apart from the row list so a failed fetch renders as a failure. An
  // error folded into "no templates" reads as a statement about the company.
  const [failure, setFailure] = useState<string | null>(null);
  const [editing, setEditing] = useState<DocumentTemplate | 'new' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<DocumentTemplate | null>(null);
  const [deleting, setDeleting] = useState(false);

  // `loading` is only ever cleared here, never re-raised: this reloads after
  // every save, delete and editor close, and re-raising it would replace the
  // list the caller is looking at with skeleton rows each time.
  const load = useCallback(async () => {
    setFailure(null);
    try {
      const page = await api.documentTemplates();
      setTemplates(page.items);
      setCursor(page.nextCursor);
    } catch (caught) {
      setFailure(caught instanceof Error ? caught.message : t('documents.templates.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, revision]);

  async function loadMore(): Promise<void> {
    if (!cursor) return;
    setPaging(true);
    try {
      const page = await api.documentTemplates({ cursor });
      setTemplates((current) => [...current, ...page.items]);
      setCursor(page.nextCursor);
    } catch (caught) {
      setFailure(caught instanceof Error ? caught.message : t('documents.templates.loadFailed'));
    } finally {
      setPaging(false);
    }
  }

  /**
   * Closing refetches, because one way out of the editor is the conflict
   * banner's "Reload theirs" — leaving the list holding the very version the
   * server just refused would make the next save fail for the same reason.
   */
  function closeEditor(): void {
    setEditing(null);
    void load();
  }

  async function remove(template: DocumentTemplate): Promise<void> {
    setDeleting(true);
    try {
      await api.deleteDocumentTemplate(template.id, template.version);
      setConfirmDelete(null);
      toast.push(t('documents.templates.deleted', { name: template.name }), { tone: 'ok' });
      await load();
    } catch (caught) {
      // A stale version fails here exactly as it does in the editor, and for
      // the same reason: somebody else changed the template since this list
      // was fetched, so the delete is refused rather than applied to a row
      // that no longer looks like this.
      setFailure(caught instanceof Error ? caught.message : t('documents.templates.deleteFailed'));
      setConfirmDelete(null);
    } finally {
      setDeleting(false);
    }
  }

  const columns: DataTableColumn<DocumentTemplate>[] = [
    {
      key: 'name',
      header: t('documents.templates.colName'),
      render: (template) => (
        <span className="ob-body-strong">
          {template.name}
          {template.isDefault && (
            <>
              {' '}
              <StatusPill tone="accent">{t('documents.templates.defaultBadge')}</StatusPill>
            </>
          )}
        </span>
      ),
    },
    {
      key: 'type',
      header: t('documents.templates.colType'),
      width: rem(190),
      render: (template) => t(DOCUMENT_TYPE_KEY[template.documentType]),
    },
    {
      key: 'paper',
      header: t('documents.templates.colPaper'),
      priority: 3,
      width: rem(150),
      render: (template) =>
        `${template.paperSize} · ${t(`documents.orientation.${template.orientation}`)}`,
    },
    {
      key: 'rates',
      header: t('documents.templates.colRates'),
      priority: 2,
      width: rem(110),
      render: (template) =>
        template.showRates ? (
          <StatusPill tone="ok">{t('documents.templates.ratesShown')}</StatusPill>
        ) : (
          <StatusPill>{t('documents.templates.ratesHidden')}</StatusPill>
        ),
    },
    {
      key: 'updated',
      header: t('documents.templates.colUpdated'),
      priority: 3,
      width: rem(170),
      render: (template) => formatDateTime(template.updatedAt),
    },
    {
      key: 'actions',
      header: '',
      width: rem(110),
      align: 'right',
      render: (template) =>
        canDelete ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={(event) => {
              event.stopPropagation();
              setConfirmDelete(template);
            }}
          >
            {t('documents.templates.delete')}
          </Button>
        ) : null,
    },
  ];

  return (
    <Section
      title={t('documents.templates.sectionTitle')}
      action={
        canCreate ? (
          <Button variant="primary" onClick={() => setEditing('new')}>
            {t('documents.templates.create')}
          </Button>
        ) : null
      }
    >
      {/* A failure with rows already on screen is a failed action — a delete or
          a second page — so it is reported above the list the caller is still
          looking at. A failure with nothing on screen takes the list's place
          below, because "no templates" would be a claim, not a report. */}
      {failure && templates.length > 0 && <ConflictBanner>{failure}</ConflictBanner>}

      <Modal
        open={editing !== null}
        onClose={closeEditor}
        size="lg"
        title={editing === 'new' ? t('documents.editor.newTitle') : (editing?.name ?? '')}
        subtitle={
          editing && editing !== 'new' ? t(DOCUMENT_TYPE_KEY[editing.documentType]) : undefined
        }
      >
        {editing && (
          <TemplateEditor
            // Remounting on the edited id throws away a draft that belonged to
            // a different template, which is what opening another row means.
            key={editing === 'new' ? 'new' : editing.id}
            template={editing === 'new' ? null : editing}
            canSave={editing === 'new' ? canCreate : canEdit}
            canRender={canRender}
            onSaved={(name) => {
              setEditing(null);
              toast.push(t('documents.editor.saved', { name }), { tone: 'ok' });
              void load();
            }}
            onCancel={closeEditor}
          />
        )}
      </Modal>

      <Card padded={false}>
        {loading ? (
          <SkeletonTable columns={columns} rows={5} />
        ) : failure && templates.length === 0 ? (
          <ErrorState
            title={t('documents.templates.loadFailed')}
            description={failure}
            actionLabel={t('action.retryNow')}
            onAction={() => void load()}
          />
        ) : (
          <DataTable
            columns={columns}
            rows={templates}
            rowKey={(template) => template.id}
            openOn="click"
            // A caller who cannot edit still gets the dialog: it is the only
            // place the eight switches and the terms text are readable, and
            // the editor disables its own controls rather than lying about
            // what the template says.
            onRowOpen={(template) => setEditing(template)}
            selectedId={editing && editing !== 'new' ? editing.id : undefined}
            empty={
              <EmptyState
                title={t('documents.templates.empty.title')}
                description={t('documents.templates.empty.description')}
                actionLabel={canCreate ? t('documents.templates.create') : undefined}
                onAction={canCreate ? () => setEditing('new') : undefined}
              />
            }
          />
        )}
      </Card>

      <LoadMorePager
        hasMore={Boolean(cursor)}
        loading={paging}
        onLoadMore={() => void loadMore()}
        label={t('documents.loadMore')}
      />

      <Modal
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        title={t('documents.templates.deleteConfirmTitle', { name: confirmDelete?.name ?? '' })}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDelete(null)}>
              {t('documents.cancel')}
            </Button>
            <Button
              variant="danger"
              busy={deleting}
              onClick={() => confirmDelete && void remove(confirmDelete)}
            >
              {t('documents.templates.delete')}
            </Button>
          </>
        }
      >
        {t('documents.templates.deleteConfirmBody')}
      </Modal>
    </Section>
  );
}

// --- The editor -------------------------------------------------------------

/** The eight switches, grouped so the form is read rather than scanned. */
type ToggleKey =
  | 'showRates'
  | 'showColourChips'
  | 'showTerms'
  | 'showLogo'
  | 'showSignature'
  | 'showPageNumbers'
  | 'showWatermark'
  | 'showPartyBlock';

const TOGGLE_GROUPS: { titleKey: string; keys: ToggleKey[] }[] = [
  {
    titleKey: 'documents.editor.group.content',
    keys: ['showRates', 'showColourChips', 'showPartyBlock'],
  },
  {
    titleKey: 'documents.editor.group.branding',
    keys: ['showLogo', 'showWatermark', 'showSignature'],
  },
  { titleKey: 'documents.editor.group.pageFurniture', keys: ['showTerms', 'showPageNumbers'] },
];

const TOGGLE_LABEL_KEY: Record<ToggleKey, string> = {
  showRates: 'documents.editor.showRates',
  showColourChips: 'documents.editor.showColourChips',
  showPartyBlock: 'documents.editor.showPartyBlock',
  showLogo: 'documents.editor.showLogo',
  showWatermark: 'documents.editor.showWatermark',
  showSignature: 'documents.editor.showSignature',
  showTerms: 'documents.editor.showTerms',
  showPageNumbers: 'documents.editor.showPageNumbers',
};

type Draft = DocumentTemplateInput & Required<Pick<DocumentTemplateInput, 'margins'>>;

function draftFrom(template: DocumentTemplate | null, documentType: DocumentType): Draft {
  if (template) {
    return {
      name: template.name,
      documentType: template.documentType,
      paperSize: template.paperSize,
      orientation: template.orientation,
      margins: { ...template.margins },
      showRates: template.showRates,
      showColourChips: template.showColourChips,
      showTerms: template.showTerms,
      showLogo: template.showLogo,
      showSignature: template.showSignature,
      showPageNumbers: template.showPageNumbers,
      showWatermark: template.showWatermark,
      showPartyBlock: template.showPartyBlock,
      watermarkText: template.watermarkText,
      termsText: template.termsText,
      footerText: template.footerText,
      accentColour: template.accentColour,
      locale: template.locale,
      layout: template.layout,
      logoAssetId: template.logoAssetId,
      signatureAssetId: template.signatureAssetId,
      isDefault: template.isDefault,
    };
  }

  // Copied, not referenced: `TEMPLATE_DEFAULTS` is a module-level constant
  // shared by every draft this session opens, and a draft that edited it in
  // place would change what the *next* new template starts from.
  const defaults = TEMPLATE_DEFAULTS[documentType];
  return {
    ...defaults,
    margins: { ...defaults.margins },
    layout: { blocks: [...defaults.layout.blocks] },
  };
}

function TemplateEditor({
  template,
  canSave,
  canRender,
  onSaved,
  onCancel,
}: {
  template: DocumentTemplate | null;
  canSave: boolean;
  canRender: boolean;
  onSaved: (name: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() =>
    draftFrom(template, template?.documentType ?? 'quotation'),
  );
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{
    message: string;
    diff: Record<string, FieldDifference>;
  } | null>(null);
  const [baseVersion, setBaseVersion] = useState<number | undefined>(template?.version);

  function set<K extends keyof Draft>(key: K, value: Draft[K]): void {
    setDraft((current) => {
      // Annotated rather than inferred: the eight switches write through a
      // generic key, and only a target typed as `Draft` makes that write
      // check against `Draft[K]` instead of a fresh spread type.
      const next: Draft = { ...current };
      next[key] = value;
      return next;
    });
  }

  /**
   * Changing the type of a *new* template reloads the whole default set: a
   * dispatch note that kept a quotation's `showRates: true` is exactly the
   * mistake `TEMPLATE_DEFAULTS` exists to prevent. An existing template keeps
   * its own values — its type is a correction, not a reset.
   */
  function changeType(next: DocumentType): void {
    if (template) set('documentType', next);
    else setDraft(draftFrom(null, next));
  }

  async function save(overwrite = false): Promise<void> {
    setBusy(true);
    setFailure(null);
    setConflict(null);
    try {
      const input: DocumentTemplateInput = { ...draft, name: draft.name.trim() };
      if (template) {
        // On an explicit Overwrite, re-base on the version the server reported
        // rather than the one this drawer opened with. Never automatic: taking
        // the other person's version silently is how their edit disappears.
        await api.updateDocumentTemplate(template.id, {
          ...input,
          expectedVersion: overwrite ? (baseVersion ?? template.version) : template.version,
        });
      } else {
        await api.createDocumentTemplate(input);
      }
      onSaved(input.name);
    } catch (caught) {
      if (caught instanceof ApiError && caught.isConflict && caught.storedVersion !== undefined) {
        setBaseVersion(caught.storedVersion);
        setConflict({ message: caught.message, diff: caught.diff });
      } else {
        setFailure(caught instanceof Error ? caught.message : t('documents.editor.saveFailed'));
      }
    } finally {
      setBusy(false);
    }
  }

  const margins = draft.margins;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
      {failure && <ConflictBanner>{failure}</ConflictBanner>}

      {conflict && (
        <ConflictBanner
          action={
            <div style={{ display: 'flex', gap: 'var(--s-8)' }}>
              <Button variant="secondary" size="sm" onClick={onCancel}>
                {t('documents.editor.reloadTheirs')}
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void save(true)}>
                {t('documents.editor.overwriteMine')}
              </Button>
            </div>
          }
        >
          <strong>{conflict.message}</strong>
          {Object.keys(conflict.diff).length > 0 && (
            <ul style={{ margin: 'var(--s-8) 0 0', paddingLeft: 'var(--s-20)' }}>
              {Object.entries(conflict.diff).map(([field, difference]) => (
                <li key={field}>
                  <strong>{field}</strong>: {t('documents.editor.theirs')}{' '}
                  <code>{String(difference.stored)}</code>, {t('documents.editor.yours')}{' '}
                  <code>{String(difference.incoming)}</code>
                </li>
              ))}
            </ul>
          )}
        </ConflictBanner>
      )}

      <Card className="ob-measure-form">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--s-16)' }}>
          <FormField label={t('documents.editor.name')} required>
            {(id) => (
              <Input
                id={id}
                value={draft.name}
                disabled={!canSave}
                onChange={(event) => set('name', event.target.value)}
              />
            )}
          </FormField>

          <FormField label={t('documents.editor.documentType')}>
            {(id) => (
              <Select
                id={id}
                value={draft.documentType}
                disabled={!canSave}
                onChange={(event) => changeType(event.target.value as DocumentType)}
              >
                {DOCUMENT_TYPES.map((value) => (
                  <option key={value} value={value}>
                    {t(DOCUMENT_TYPE_KEY[value])}
                  </option>
                ))}
              </Select>
            )}
          </FormField>

          <FormField label={t('documents.editor.paperSize')}>
            {(id) => (
              <Select
                id={id}
                value={draft.paperSize}
                disabled={!canSave}
                onChange={(event) => set('paperSize', event.target.value as PaperSize)}
              >
                {PAPER_SIZES.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </Select>
            )}
          </FormField>

          <FormField label={t('documents.editor.orientation')}>
            {(id) => (
              <Select
                id={id}
                value={draft.orientation}
                disabled={!canSave}
                onChange={(event) => set('orientation', event.target.value as PageOrientation)}
              >
                {PAGE_ORIENTATIONS.map((value) => (
                  <option key={value} value={value}>
                    {t(`documents.orientation.${value}`)}
                  </option>
                ))}
              </Select>
            )}
          </FormField>

          <FormField
            label={t('documents.editor.accentColour')}
            hint={t('documents.editor.accentHint')}
          >
            {(id) => (
              <Input
                id={id}
                value={draft.accentColour ?? ''}
                placeholder="#2F6FEB"
                disabled={!canSave}
                onChange={(event) => set('accentColour', event.target.value.trim() || null)}
              />
            )}
          </FormField>

          <FormField label={t('documents.editor.default')} hint={t('documents.editor.defaultHint')}>
            {() => (
              <Switch
                checked={draft.isDefault ?? false}
                disabled={!canSave}
                label={t('documents.editor.defaultLabel')}
                onChange={(next) => set('isDefault', next)}
              />
            )}
          </FormField>
        </div>
      </Card>

      <Card className="ob-measure-form">
        <h3 className="ob-title" style={{ margin: '0 0 var(--s-8)' }}>
          {t('documents.editor.group.margins')}
        </h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--s-12)' }}>
          {(['top', 'right', 'bottom', 'left'] as const).map((edge) => (
            <FormField key={edge} label={t(`documents.editor.margin.${edge}`)}>
              {(id) => (
                <NumberInput
                  id={id}
                  value={String(margins[edge])}
                  disabled={!canSave}
                  onChange={(event) => {
                    // Millimetres, whole numbers. A blank box means 0 rather
                    // than NaN, which the server would reject as a type error
                    // halfway through typing.
                    const digits = event.target.value.replace(/[^\d]/g, '');
                    const next = { ...margins };
                    next[edge] = digits === '' ? 0 : Number(digits);
                    set('margins', next);
                  }}
                />
              )}
            </FormField>
          ))}
        </div>
      </Card>

      <Card className="ob-measure-form">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
          {TOGGLE_GROUPS.map((group) => (
            <div
              key={group.titleKey}
              style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}
            >
              <span className="ob-small" style={{ color: 'var(--fg-secondary)' }}>
                {t(group.titleKey)}
              </span>
              {group.keys.map((key) => (
                <Switch
                  key={key}
                  checked={Boolean(draft[key])}
                  disabled={!canSave}
                  label={t(TOGGLE_LABEL_KEY[key])}
                  onChange={(next) => set(key, next)}
                />
              ))}
            </div>
          ))}
        </div>
      </Card>

      <Card className="ob-measure-form">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-12)' }}>
          {draft.showWatermark && (
            <FormField label={t('documents.editor.watermarkText')}>
              {(id) => (
                <Input
                  id={id}
                  value={draft.watermarkText ?? ''}
                  disabled={!canSave}
                  onChange={(event) => set('watermarkText', event.target.value || null)}
                />
              )}
            </FormField>
          )}

          {draft.showTerms && (
            <FormField
              label={t('documents.editor.termsText')}
              hint={t('documents.editor.termsHint', { max: MAX_TERMS_LENGTH })}
            >
              {(id) => (
                <Textarea
                  id={id}
                  rows={4}
                  maxLength={500}
                  value={draft.termsText ?? ''}
                  disabled={!canSave}
                  onChange={(event) => set('termsText', event.target.value || null)}
                />
              )}
            </FormField>
          )}

          <FormField label={t('documents.editor.footerText')}>
            {(id) => (
              <Input
                id={id}
                value={draft.footerText ?? ''}
                disabled={!canSave}
                onChange={(event) => set('footerText', event.target.value || null)}
              />
            )}
          </FormField>
        </div>
      </Card>

      {canRender && <PreviewPanel draft={draft} />}

      <div style={{ display: 'flex', gap: 'var(--s-8)', justifyContent: 'flex-end' }}>
        <Button variant="secondary" onClick={onCancel}>
          {t('documents.cancel')}
        </Button>
        {canSave && (
          <Button
            variant="primary"
            busy={busy}
            disabled={!draft.name.trim()}
            onClick={() => void save()}
          >
            {t('documents.editor.save')}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Preview renders the *draft*, not the stored template — that is the whole
 * point of `/preview` taking a template body instead of an id. It still needs
 * a real subject, because a preview with invented lines would not show what
 * this template does to this company's data, so the subject is picked from
 * recent orders and leads rather than faked.
 */
function PreviewPanel({ draft }: { draft: DocumentTemplateInput }) {
  const [fetched, setFetched] = useState<PreviewSubject[] | null>(null);
  const [unreadable, setUnreadable] = useState(false);
  const [chosen, setChosen] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const loadSubjects = useCallback(async () => {
    setUnreadable(false);
    const [orders, leads] = await Promise.all([
      api.orders().catch(() => null),
      api.leads().catch(() => null),
    ]);
    // Both refused is a failure, not an absence. A caller who may not open
    // leads or orders would otherwise be told this company has none, which is
    // a statement about the data rather than about their own permissions.
    if (!orders && !leads) {
      setUnreadable(true);
      setFetched([]);
      return;
    }
    setFetched([
      ...(orders?.items ?? []).map((order) => ({
        kind: 'order' as const,
        id: order.id,
        label: `${order.id} · ${order.partyName}`,
      })),
      ...(leads?.items ?? []).map((lead) => ({
        kind: 'lead' as const,
        id: lead.id,
        label: `${lead.id} · ${lead.partyName}`,
      })),
    ]);
  }, []);

  useEffect(() => {
    void loadSubjects();
  }, [loadSubjects]);

  /**
   * Only a quotation reads correctly for a lead — the server refuses the other
   * two against one (`assertTemplateAppliesTo`). Offering a lead for a dispatch
   * note would be a control whose only outcome is a 400.
   */
  const subjects = useMemo(
    () =>
      fetched?.filter((option) => option.kind === 'order' || draft.documentType === 'quotation') ??
      null,
    [fetched, draft.documentType],
  );

  // Derived rather than seeded, so switching the document type out from under
  // a chosen lead falls back to a subject that is still on offer.
  const subject =
    subjects?.find((option) => subjectKey(option) === chosen) ?? subjects?.[0] ?? null;

  async function preview(): Promise<void> {
    if (!subject) return;
    // Opened inside the click, not after the render returns: a `window.open`
    // that lands once the await has resolved has no user gesture behind it any
    // more, and the browser blocks it silently.
    const tab = window.open('', '_blank');
    if (!tab) {
      setFailure(t('documents.preview.popupBlocked'));
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      const blob = await api.previewDocument({
        template: draft,
        subjectKind: subject.kind,
        subjectId: subject.id,
      });
      // A tab rather than an inline frame: the browser's own PDF viewer is
      // better than anything this screen would build. Revoking immediately
      // would race the tab's own fetch of the blob, so the URL is held long
      // enough for that to have happened and then released — a preview is a
      // few hundred kilobytes, not something to leak for the session.
      const url = URL.createObjectURL(blob);
      tab.location.replace(url);
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (caught) {
      tab.close();
      setFailure(caught instanceof Error ? caught.message : t('documents.preview.failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="ob-measure-form">
      <h3 className="ob-title" style={{ margin: '0 0 var(--s-4)' }}>
        {t('documents.preview.title')}
      </h3>
      <p className="ob-small" style={{ margin: '0 0 var(--s-12)', color: 'var(--fg-secondary)' }}>
        {t('documents.preview.description')}
      </p>

      {failure && (
        <div style={{ marginBottom: 'var(--s-12)' }}>
          <ConflictBanner>{failure}</ConflictBanner>
        </div>
      )}

      {subjects === null ? (
        <span className="ob-small">{t('documents.preview.loadingSubjects')}</span>
      ) : unreadable ? (
        <ErrorState
          title={t('documents.preview.subjectsFailed')}
          actionLabel={t('action.retryNow')}
          onAction={() => void loadSubjects()}
        />
      ) : subjects.length === 0 ? (
        <span className="ob-small">{t('documents.preview.noSubjects')}</span>
      ) : (
        <div style={{ display: 'flex', gap: 'var(--s-8)', alignItems: 'flex-end' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <FormField label={t('documents.preview.subject')}>
              {(id) => (
                <Select
                  id={id}
                  value={subject ? subjectKey(subject) : ''}
                  onChange={(event) => setChosen(event.target.value)}
                >
                  {subjects.map((option) => (
                    <option key={subjectKey(option)} value={subjectKey(option)}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              )}
            </FormField>
          </div>
          <Button busy={busy} disabled={!subject} onClick={() => void preview()}>
            {t('documents.preview.action')}
          </Button>
        </div>
      )}
    </Card>
  );
}

// --- Export history ---------------------------------------------------------

function ExportsTab({ revision }: { revision: number }) {
  const [exports, setExports] = useState<DocumentExport[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [paging, setPaging] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(async () => {
    setFailure(null);
    try {
      const page = await api.documentExports();
      setExports(page.items);
      setCursor(page.nextCursor);
    } catch (caught) {
      setFailure(caught instanceof Error ? caught.message : t('documents.exports.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, revision]);

  async function loadMore(): Promise<void> {
    if (!cursor) return;
    setPaging(true);
    try {
      const page = await api.documentExports({ cursor });
      setExports((current) => [...current, ...page.items]);
      setCursor(page.nextCursor);
    } catch (caught) {
      setFailure(caught instanceof Error ? caught.message : t('documents.exports.loadFailed'));
    } finally {
      setPaging(false);
    }
  }

  const columns: DataTableColumn<DocumentExport>[] = [
    {
      key: 'when',
      header: t('documents.exports.colWhen'),
      width: rem(170),
      render: (row) => formatDateTime(row.createdAt),
    },
    {
      key: 'document',
      header: t('documents.exports.colDocument'),
      render: (row) => (
        <span className="ob-body-strong" title={row.fileName}>
          {row.fileName}
        </span>
      ),
    },
    {
      key: 'type',
      header: t('documents.exports.colType'),
      width: rem(170),
      render: (row) => t(DOCUMENT_TYPE_KEY[row.documentType]),
    },
    {
      key: 'subject',
      header: t('documents.exports.colSubject'),
      width: rem(200),
      render: (row) => row.subjectLabel,
    },
    {
      key: 'template',
      header: t('documents.exports.colTemplate'),
      width: rem(160),
      // Denormalised on the export row, so this still reads correctly after
      // the template was renamed or deleted.
      render: (row) => row.templateName,
    },
    {
      key: 'rates',
      header: t('documents.exports.colRates'),
      width: rem(110),
      render: (row) =>
        row.ratesIncluded ? (
          <StatusPill tone="accent">{t('documents.exports.withRates')}</StatusPill>
        ) : (
          <StatusPill>{t('documents.exports.withoutRates')}</StatusPill>
        ),
    },
    {
      key: 'pages',
      header: t('documents.exports.colPages'),
      width: rem(80),
      align: 'right',
      render: (row) => String(row.pageCount),
    },
    {
      key: 'size',
      header: t('documents.exports.colSize'),
      width: rem(90),
      align: 'right',
      render: (row) => formatBytes(row.byteSize),
    },
    {
      key: 'by',
      header: t('documents.exports.colRenderedBy'),
      width: rem(150),
      render: (row) => row.renderedByName ?? t('documents.exports.renderedByPanel'),
    },
    {
      key: 'download',
      header: '',
      width: rem(120),
      align: 'right',
      render: (row) => (
        <ButtonLink href={api.documentExportUrl(row.id)} variant="secondary" size="sm">
          {t('documents.exports.download')}
        </ButtonLink>
      ),
    },
  ];

  return (
    <Section title={t('documents.exports.sectionTitle')}>
      <p className="ob-small" style={{ margin: 0, color: 'var(--fg-secondary)' }}>
        {t('documents.exports.description')}
      </p>

      {/* A failed *next page* keeps the pages already on screen and says so
          above them; a first fetch that failed has nothing to keep. */}
      {failure && exports.length > 0 && <ConflictBanner>{failure}</ConflictBanner>}

      <Card padded={false}>
        {loading ? (
          <SkeletonTable columns={columns} rows={6} />
        ) : failure && exports.length === 0 ? (
          <ErrorState
            title={t('documents.exports.loadFailed')}
            description={failure}
            actionLabel={t('action.retryNow')}
            onAction={() => void load()}
          />
        ) : (
          <DataTable
            columns={columns}
            rows={exports}
            rowKey={(row) => row.id}
            empty={
              <EmptyState
                title={t('documents.exports.empty.title')}
                description={t('documents.exports.empty.description')}
              />
            }
          />
        )}
      </Card>

      <LoadMorePager
        hasMore={Boolean(cursor)}
        loading={paging}
        onLoadMore={() => void loadMore()}
        label={t('documents.loadMore')}
      />
    </Section>
  );
}
