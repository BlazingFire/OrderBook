/**
 * Documents — PDF templates, the page designer, and the export history
 * (docs/backend-modules/04-API-CONTRACT.md §6).
 *
 * Lives in `ui/` and takes a **transport**, so the Master and an Office panel
 * mount the same screen rather than keeping two copies in step by hand — the
 * pattern `GalleryScreen` already follows. Each panel
 * supplies its own reads: the Master calls its HTTP API directly, an Office
 * panel proxies the same calls through to the Master over its socket.
 *
 * `conflictOf` is part of the transport for the same reason. Optimistic locking
 * is a fact of this API, but each panel has its own `ApiError`, and a shared
 * screen that reached for one of them would bind itself to that panel.
 *
 * Two tabs because they are two different kinds of record, not two views of
 * one: a template is editable and recyclable, an export is neither. A document
 * that went to a customer is the evidence of what was sent, so nothing here
 * offers to delete one — the only action on an export is fetching the same
 * bytes back.
 *
 * The editor is no longer a form: `PageDesigner` owns `layout`, and the form
 * fields above it own the paper, the margins and the eight switches — which
 * stay typed columns rather than moving into the layout JSON.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  DocumentBlockKind,
  DocumentElement,
  DocumentExport,
  DocumentTemplate,
  CustomFieldDefinition,
  DocumentLayoutV2,
  DocumentTemplateInput,
  DocumentSubjectKind,
  DocumentType,
  PageGeometry,
  PageOrientation,
  PaperSize,
  TemplateDefaults,
} from '@orderbook/shared';
import {
  DOCUMENT_TYPES,
  MAX_ELEMENTS,
  MAX_TERMS_LENGTH,
  PAGE_ORIENTATIONS,
  PAPER_SIZES,
  STARTER_DESIGNS,
  TEMPLATE_DEFAULTS,
  normaliseLayout,
} from '@orderbook/shared';

import { Button, ButtonLink } from './Button.js';
import { Card, Section } from './Card.js';
import { DataTable, type DataTableColumn } from './DataTable.js';
import { bundleForBlock, DESIGNER_BLOCKS } from './documentBlocks.js';
import { Checkbox, FormField, Input, NumberInput, Switch, Textarea } from './Form.js';
import { Icon } from './icons.js';
import { Segmented } from './Tabs.js';
import { Select } from './SuggestInput.js';
import { EmptyState, ErrorState, ConflictBanner, SkeletonTable } from './States.js';
import { StatusPill } from './DataDisplay.js';
import { LoadMorePager } from './CursorPager.js';
import { Modal } from './Modal.js';
import { EditorScreen } from './EditorScreen.js';
import { useSubNav } from './SubNavSlot.js';
import { useToast } from './Toast.js';
import { PageDesigner } from './PageDesigner.js';
import { PageDesignerCanvas } from './PageDesignerCanvas.js';
import { bindingChoices } from './PageDesigner.js';
import { pageFrame, scaleFor, shiftBundle, tidy } from './pageDesignerGeometry.js';
import { formatBytes, formatDateTime } from './format.js';
import { rem } from './rem.js';
import { t } from './i18n.js';

/** A field a stale save disagrees with the server about. Matches the shape both
 *  panels' api clients already build from `details.diff`. */
export interface FieldDifference {
  stored: unknown;
  incoming: unknown;
}

/** A page of rows, as every list endpoint returns one. */
interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Everything this screen needs from the panel it is mounted in.
 *
 * Narrow on purpose. A transport that exposed a whole api client would let this
 * screen reach for anything, and the two panels do not have the same anything.
 */
export interface DocumentsTransport {
  templates(options?: { cursor?: string }): Promise<Page<DocumentTemplate>>;
  createTemplate(input: DocumentTemplateInput): Promise<DocumentTemplate>;
  updateTemplate(
    id: string,
    input: DocumentTemplateInput & { expectedVersion: number },
  ): Promise<DocumentTemplate>;
  deleteTemplate(id: string, expectedVersion: number): Promise<unknown>;
  preview(input: Record<string, unknown>): Promise<Blob>;
  exports(options?: { cursor?: string }): Promise<Page<DocumentExport>>;
  exportUrl(id: string | number): string;
  customFields(): Promise<CustomFieldDefinition[]>;
  /** Real records the preview can be rendered against. */
  subjects(): Promise<PreviewSubject[]>;
  /** The panel's own reading of an optimistic-lock failure. */
  conflictOf(
    error: unknown,
  ): { message: string; storedVersion: number; diff: Record<string, FieldDifference> } | null;
}

/** The two sub-pages, chosen from the sidebar rather than inside the screen. */
export type DocumentsTab = 'templates' | 'exports';

interface Props {
  revision: number;
  /** The signed-in caller's own resolved permissions. */
  permissions: string[];
  transport: DocumentsTransport;
  tab: DocumentsTab;
}

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

export function DocumentsScreen({ revision, permissions, transport, tab }: Props) {
  const toast = useToast();
  const can = (key: string) => permissions.includes(key);
  // Absent when the company's pricing switch is off, or the role lacks it: the
  // rate switch, the rates columns and the grand-total binding go with it.
  const showMoney = can('field.saleRate.view');

  /*
   * The open operation — choosing a starter design, or the editor itself — is
   * a full screen with its own sidebar entry under Templates, not a modal: the
   * editor holds a sheet of paper and an inspector side by side, and a dialog
   * capped near 660px never showed an A4 page whole. `starter` is read once,
   * when `TemplateEditor` mounts — picking again reopens a fresh editor under
   * a new `key`, so it is never stale there.
   */
  const [editing, setEditing] = useState<DocumentTemplate | 'new' | null>(null);
  const [starter, setStarter] = useState<TemplateDefaults | null>(null);
  const [choosing, setChoosing] = useState(false);

  // Null while Exports is showing, so the shell's highlight follows the page
  // on screen; the draft itself survives the round trip.
  const operation =
    tab !== 'templates'
      ? null
      : choosing
        ? { id: 'documents.new', label: t('documents.gallery.title') }
        : editing
          ? {
              id: 'documents.editor',
              label: editing === 'new' ? t('documents.editor.newTitle') : editing.name,
            }
          : null;

  useSubNav(
    'documents',
    operation
      ? {
          parentId: 'documents.templates',
          items: [{ ...operation, icon: 'edit' }],
          activeId: operation.id,
        }
      : null,
  );

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

  function closeEditor(): void {
    setEditing(null);
    setStarter(null);
  }

  if (tab === 'templates' && choosing) {
    return (
      <EditorScreen
        title={t('documents.gallery.title')}
        backLabel={t('action.backToList')}
        onBack={() => {
          setChoosing(false);
          return true;
        }}
      >
        <StarterGallery
          onPick={(design) => {
            setStarter(design);
            setChoosing(false);
            setEditing('new');
          }}
        />
      </EditorScreen>
    );
  }

  if (tab === 'templates' && editing) {
    return (
      <DesignerEditorScreen
        editing={editing}
        transport={transport}
        starter={starter}
        canSave={editing === 'new' ? can('documents.create') : can('documents.edit')}
        canRender={can('documents.render')}
        showMoney={showMoney}
        onSaved={(name) => {
          closeEditor();
          toast.push(t('documents.editor.saved', { name }), { tone: 'ok' });
        }}
        onCancel={closeEditor}
      />
    );
  }

  return tab === 'templates' ? (
    <TemplatesTab
      transport={transport}
      revision={revision}
      canCreate={can('documents.create')}
      canDelete={can('documents.delete')}
      showMoney={showMoney}
      onOpen={setEditing}
      onNew={() => setChoosing(true)}
    />
  ) : (
    <ExportsTab revision={revision} transport={transport} showMoney={showMoney} />
  );
}

// --- Templates --------------------------------------------------------------

function TemplatesTab({
  transport,
  revision,
  canCreate,
  canDelete,
  showMoney,
  onOpen,
  onNew,
}: {
  transport: DocumentsTransport;
  revision: number;
  canCreate: boolean;
  canDelete: boolean;
  showMoney: boolean;
  onOpen: (template: DocumentTemplate) => void;
  onNew: () => void;
}) {
  const toast = useToast();
  const [templates, setTemplates] = useState<DocumentTemplate[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [paging, setPaging] = useState(false);
  // Kept apart from the row list so a failed fetch renders as a failure. An
  // error folded into "no templates" reads as a statement about the company.
  const [failure, setFailure] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<DocumentTemplate | null>(null);
  const [deleting, setDeleting] = useState(false);

  /*
   * The transport behind a ref, and an empty dependency list.
   *
   * A caller is free to build this object inline, and depending on the
   * object's identity makes that caller's ordinary React idiom into a refetch
   * loop in *this* file, which is the wrong place to discover it. The ref
   * keeps the reads current without making the identity load-bearing.
   * (`ui/tests/no-transport-dep.test.ts` enforces this.)
   */
  const transportRef = useRef(transport);
  transportRef.current = transport;

  // `loading` is only ever cleared here, never re-raised: this reloads after
  // every delete, and re-raising it would replace the list the caller is
  // looking at with skeleton rows each time. Coming back from the editor
  // remounts this list, which is the refetch that shows what was saved.
  const load = useCallback(async () => {
    setFailure(null);
    try {
      const page = await transportRef.current.templates();
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
      const page = await transport.templates({ cursor });
      setTemplates((current) => [...current, ...page.items]);
      setCursor(page.nextCursor);
    } catch (caught) {
      setFailure(caught instanceof Error ? caught.message : t('documents.templates.loadFailed'));
    } finally {
      setPaging(false);
    }
  }

  async function remove(template: DocumentTemplate): Promise<void> {
    setDeleting(true);
    try {
      await transport.deleteTemplate(template.id, template.version);
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
    ...(showMoney
      ? [
          {
            key: 'rates',
            header: t('documents.templates.colRates'),
            priority: 2,
            width: rem(110),
            render: (template: DocumentTemplate) =>
              template.showRates ? (
                <StatusPill tone="ok">{t('documents.templates.ratesShown')}</StatusPill>
              ) : (
                <StatusPill>{t('documents.templates.ratesHidden')}</StatusPill>
              ),
          } satisfies DataTableColumn<DocumentTemplate>,
        ]
      : []),
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
          <Button variant="primary" onClick={onNew}>
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
            // A caller who cannot edit still gets the editor: it is the only
            // place the eight switches and the terms text are readable, and
            // the editor disables its own controls rather than lying about
            // what the template says.
            onRowOpen={onOpen}
            empty={
              <EmptyState
                title={t('documents.templates.empty.title')}
                description={t('documents.templates.empty.description')}
                actionLabel={canCreate ? t('documents.templates.create') : undefined}
                onAction={canCreate ? onNew : undefined}
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

function draftFrom(
  template: DocumentTemplate | null,
  documentType: DocumentType,
  starter?: TemplateDefaults | null,
): Draft {
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

  // Copied, not referenced: `TEMPLATE_DEFAULTS` — and a starter design is the
  // same kind of module-level constant — is shared by every draft this session
  // opens, and a draft that edited it in place would change what the *next*
  // new template starts from, starter or no starter.
  const defaults = starter ?? TEMPLATE_DEFAULTS[documentType];
  return {
    ...defaults,
    margins: { ...defaults.margins },
    layout: { blocks: defaults.layout.blocks.map((block) => ({ ...block })) },
  };
}

/**
 * A small gallery of ready-made designs, offered before the blank editor
 * rather than instead of it.
 *
 * "Use this design" is nothing more than seeding the same draft the editor
 * always builds from `TEMPLATE_DEFAULTS` — a starter is a `TemplateDefaults`
 * with a name, and picking one is indistinguishable from a normal new
 * template the moment the editor opens. Renaming, moving elements, or
 * changing the document type afterwards is editing, the same as it would be
 * for a blank one.
 */
function StarterGallery({ onPick }: { onPick: (design: TemplateDefaults | null) => void }) {
  // Grouped under the document type rather than listed flat. Somebody opening
  // this knows which *kind* of paper they need before they know which design,
  // and a flat grid of fourteen makes them read all fourteen to find out which
  // three are dispatch notes. Headings, not a filter: there is no state to get
  // wrong and nothing to reset.
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
      <StarterGrid>
        <StarterCard
          name={t('documents.gallery.blank')}
          description={t('documents.gallery.blankDescription', {
            type: t(DOCUMENT_TYPE_KEY.quotation),
          })}
          typeLabel={t(DOCUMENT_TYPE_KEY.quotation)}
          onUse={() => onPick(null)}
        />
      </StarterGrid>

      {DOCUMENT_TYPES.map((documentType) => {
        const designs = STARTER_DESIGNS.filter((design) => design.documentType === documentType);
        if (designs.length === 0) return null;

        return (
          <section key={documentType}>
            <div className="ob-eyebrow" style={{ marginBottom: 'var(--s-8)' }}>
              {t(DOCUMENT_TYPE_KEY[documentType])}
            </div>
            <StarterGrid>
              {designs.map((design) => (
                <StarterCard
                  key={design.id}
                  name={t(design.nameToken)}
                  description={t(design.descriptionToken)}
                  typeLabel={t(DOCUMENT_TYPE_KEY[design.documentType])}
                  onUse={() => onPick(design.template)}
                />
              ))}
            </StarterGrid>
          </section>
        );
      })}
    </div>
  );
}

function StarterGrid({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(15rem, 1fr))',
        gap: 'var(--s-12)',
      }}
    >
      {children}
    </div>
  );
}

function StarterCard({
  name,
  description,
  typeLabel,
  onUse,
}: {
  name: string;
  description: string;
  typeLabel: string;
  onUse: () => void;
}) {
  return (
    <Card>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-8)', height: '100%' }}>
        <div>
          <div className="ob-body-strong">{name}</div>
          <StatusPill tone="default">{typeLabel}</StatusPill>
        </div>
        <p className="ob-small" style={{ flex: 1 }}>
          {description}
        </p>
        <Button variant="secondary" onClick={onUse}>
          {t('documents.gallery.use')}
        </Button>
      </div>
    </Card>
  );
}

function DesignerEditorScreen({
  editing,
  transport,
  starter,
  canSave,
  canRender,
  showMoney,
  onSaved,
  onCancel,
}: {
  editing: DocumentTemplate | 'new';
  transport: DocumentsTransport;
  starter: TemplateDefaults | null;
  canSave: boolean;
  canRender: boolean;
  showMoney: boolean;
  onSaved: (name: string) => void;
  onCancel: () => void;
}) {
  return (
    <EditorScreen
      title={t('documents.designer.title')}
      meta={
        editing !== 'new' ? (
          <StatusPill tone="default">{t(DOCUMENT_TYPE_KEY[editing.documentType])}</StatusPill>
        ) : undefined
      }
      backLabel={t('action.backToList')}
      onBack={() => {
        onCancel();
        return true;
      }}
    >
      <TemplateEditor
        transport={transport}
        // Remounting on the edited id throws away a draft that belonged to
        // a different template, which is what opening another row means.
        key={editing === 'new' ? 'new' : editing.id}
        template={editing === 'new' ? null : editing}
        starter={editing === 'new' ? starter : null}
        canSave={canSave}
        canRender={canRender}
        showMoney={showMoney}
        onSaved={onSaved}
        onCancel={onCancel}
      />
    </EditorScreen>
  );
}

/**
 * Margin presets behind the Narrow / Normal / Wide segmented control.
 *
 * Whole numbers, because the server validates integer millimetres 5–50 — and
 * top+bottom must stay at or under 48 or the smallest page refuses the save.
 */
const MARGIN_PRESETS = {
  narrow: { top: 10, right: 10, bottom: 10, left: 10 },
  normal: { top: 18, right: 15, bottom: 18, left: 15 },
  wide: { top: 24, right: 20, bottom: 24, left: 20 },
} as const;

type MarginPreset = keyof typeof MARGIN_PRESETS;

function marginPresetOf(margins: Draft['margins']): MarginPreset | null {
  for (const [name, preset] of Object.entries(MARGIN_PRESETS) as Array<[MarginPreset, Draft['margins']]>) {
    if (
      margins.top === preset.top &&
      margins.right === preset.right &&
      margins.bottom === preset.bottom &&
      margins.left === preset.left
    ) {
      return name;
    }
  }
  return null;
}

/** Subtitle per document type, as the screenshot's Templates rail shows it. */
const DESIGNER_TYPE_HINT: Record<DocumentType, string> = {
  quotation: 'documents.designer.fromLead',
  order_confirmation: 'documents.designer.fromOrder',
  dispatch_note: 'documents.designer.atDispatch',
};

const BLOCK_LABEL_KEY: Record<DocumentBlockKind, string> = {
  header: 'documents.designer.block.header',
  party: 'documents.designer.block.party',
  lines: 'documents.designer.block.lines',
  totals: 'documents.designer.block.totals',
  terms: 'documents.designer.block.terms',
  signature: 'documents.designer.block.signature',
};

function TemplateEditor({
  transport,
  template,
  starter,
  canSave,
  canRender,
  showMoney,
  onSaved,
  onCancel,
}: {
  transport: DocumentsTransport;
  template: DocumentTemplate | null;
  /** Only read for a brand-new template — ignored once one exists to edit. */
  starter?: TemplateDefaults | null;
  canSave: boolean;
  canRender: boolean;
  showMoney: boolean;
  onSaved: (name: string) => void;
  onCancel: () => void;
}) {
  // The transport behind a ref, never in a dependency array — see the note in
  // `TemplatesTab`, and `ui/tests/no-transport-dep.test.ts`.
  const transportRef = useRef(transport);
  transportRef.current = transport;

  const [draft, setDraft] = useState<Draft>(() =>
    draftFrom(template, template?.documentType ?? starter?.documentType ?? 'quotation', starter),
  );
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{
    message: string;
    diff: Record<string, FieldDifference>;
  } | null>(null);
  const [baseVersion, setBaseVersion] = useState<number | undefined>(template?.version);

  /*
   * Fetched once as the editor opens, not per render.
   *
   * The palette needs the tenant's own field definitions so a field added on
   * the Fields screen can be placed on a page. A failure is not worth
   * surfacing: the catalogue bindings still work, and the palette is simply
   * shorter — an error banner over a template editor because a secondary list
   * did not load would be noise.
   */
  const [customFields, setCustomFields] = useState<CustomFieldDefinition[]>([]);

  useEffect(() => {
    void transportRef.current
      .customFields()
      .then(setCustomFields)
      .catch(() => setCustomFields([]));
  }, []);

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
    else {
      setInsertion(null);
      setDraft(draftFrom(null, next));
    }
  }

  // --- the designer shell -------------------------------------------------
  //
  // The draft, the save and the conflict flow are unchanged from the stacked
  // form this replaces — only the arrangement is new: a Templates + Blocks
  // rail left, the free canvas centre, Template Options right, Preview + Save
  // in the `EditorScreen` head.
  const toast = useToast();
  const [insertion, setInsertion] = useState<{
    kind: DocumentBlockKind;
    atMm: { x: number; y: number } | null;
    nonce: number;
  } | null>(null);

  const geometry: PageGeometry = useMemo(
    () => ({
      paperSize: draft.paperSize ?? 'A4',
      orientation: draft.orientation ?? 'portrait',
      margins: draft.margins ?? { ...MARGIN_PRESETS.normal },
    }),
    [draft.paperSize, draft.orientation, draft.margins],
  );

  const layout = useMemo(
    () =>
      normaliseLayout(draft.layout, geometry, {
        hasLogo: draft.showLogo ?? true,
        hasSignature: draft.showSignature ?? false,
      }),
    [draft.layout, geometry, draft.showLogo, draft.showSignature],
  );

  const bindings = useMemo(
    () => designerBindings(customFields, showMoney),
    [customFields, showMoney],
  );

  const insertElements = useCallback(
    (atMm: { x: number; y: number } | null): DocumentElement[] | null => {
      const kind = insertion?.kind;
      if (!kind) return null;
      if (kind === 'lines' && layout.elements.some((element) => element.kind === 'table')) {
        toast.push(t('documents.designer.linesExists'), { tone: 'error' });
        return null;
      }
      const bundle = bundleForBlock(kind, geometry, {
        hasLogo: draft.showLogo ?? true,
        hasSignature: draft.showSignature ?? false,
      });
      if (layout.elements.length + bundle.length > MAX_ELEMENTS) {
        toast.push(t('documents.designer.tooManyElements'), { tone: 'error' });
        return null;
      }
      if (kind === 'signature' || !atMm) return bundle;
      const { margins } = pageFrame(geometry);
      return shiftBundle(bundle, atMm).map((element) => {
        if (element.kind === 'rule') return element;
        const w = Math.min(element.w, margins.w);
        const h = Math.min(element.h, margins.h);
        const x = Math.min(Math.max(element.x, margins.x), margins.x + margins.w - w);
        const y = Math.min(Math.max(element.y, margins.y), margins.y + margins.h - h);
        return { ...element, x: tidy(x), y: tidy(y), w: tidy(w), h: tidy(h) };
      });
    },
    [insertion?.kind, layout.elements, geometry, draft.showLogo, draft.showSignature, toast],
  );

  const placeBlock = useCallback((kind: DocumentBlockKind, atMm?: { x: number; y: number }) => {
    setInsertion({ kind, atMm: atMm ?? null, nonce: Date.now() });
  }, []);

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
        await transport.updateTemplate(template.id, {
          ...input,
          expectedVersion: overwrite ? (baseVersion ?? template.version) : template.version,
        });
      } else {
        await transport.createTemplate(input);
      }
      onSaved(input.name);
    } catch (caught) {
      const clash = transport.conflictOf(caught);
      if (clash) {
        setBaseVersion(clash.storedVersion);
        setConflict({ message: clash.message, diff: clash.diff });
      } else {
        setFailure(caught instanceof Error ? caught.message : t('documents.editor.saveFailed'));
      }
    } finally {
      setBusy(false);
    }
  }

  const margins = draft.margins;

  return (
    <DesignerShell
      draft={draft}
      nameConflict={failure}
      conflict={conflict}
      busy={busy}
      canSave={canSave}
      canRender={canRender}
      showMoney={showMoney}
      geometry={geometry}
      layout={layout}
      bindings={bindings}
      insertion={insertion}
      margins={margins}
      set={set}
      onLayout={(next) => setDraft((current) => ({ ...current, layout: next }))}
      onInsertConsumed={() => setInsertion(null)}
      insertElements={insertElements}
      placeBlock={placeBlock}
      changeType={changeType}
      save={save}
      onCancel={onCancel}
      transport={transport}
    />
  );
}

/**
 * The screenshot's three-column shell: Templates + Blocks left, the free
 * canvas centre, Template Options right. Failure and conflict banners span the
 * top; Preview + Save live in the `EditorScreen` head, not in a form footer.
 */
function DesignerShell({
  draft,
  nameConflict,
  conflict,
  busy,
  canSave,
  canRender,
  showMoney,
  geometry,
  layout,
  bindings,
  insertion,
  margins,
  set,
  onLayout,
  onInsertConsumed,
  insertElements,
  placeBlock,
  changeType,
  save,
  onCancel,
  transport,
}: {
  draft: Draft;
  nameConflict: string | null;
  conflict: { message: string; diff: Record<string, FieldDifference> } | null;
  busy: boolean;
  canSave: boolean;
  canRender: boolean;
  showMoney: boolean;
  geometry: PageGeometry;
  layout: DocumentLayoutV2;
  bindings: ReturnType<typeof bindingChoices>;
  insertion: { kind: DocumentBlockKind; atMm: { x: number; y: number } | null; nonce: number } | null;
  margins: Draft['margins'];
  set: <K extends keyof Draft>(key: K, value: Draft[K]) => void;
  onLayout: (layout: DocumentLayoutV2) => void;
  onInsertConsumed: () => void;
  insertElements: (atMm: { x: number; y: number } | null) => DocumentElement[] | null;
  placeBlock: (kind: DocumentBlockKind, atMm?: { x: number; y: number }) => void;
  changeType: (next: DocumentType) => void;
  save: (overwrite?: boolean) => Promise<void>;
  onCancel: () => void;
  transport: DocumentsTransport;
}) {
  const marginPreset = marginPresetOf(margins);
  const [showMore, setShowMore] = useState(false);
  const stageRef = useRef<HTMLDivElement | null>(null);

  function pointFromDrop(event: React.DragEvent): { x: number; y: number } | null {
    const pageEl = stageRef.current?.querySelector('.ob-designer-page');
    if (!pageEl) return null;
    const box = pageEl.getBoundingClientRect();
    const scale = scaleFor(box.width, pageFrame(geometry).page.w);
    if (scale <= 0) return null;
    return { x: tidy((event.clientX - box.left) / scale), y: tidy((event.clientY - box.top) / scale) };
  }

  return (
    <div className="ob-pdfdesigner">
      <div className="ob-pdfdesigner-alerts">
        {nameConflict && <ConflictBanner>{nameConflict}</ConflictBanner>}
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
      </div>

      <aside className="ob-pdfdesigner-rail" aria-label={t('documents.designer.templates')}>
        <div className="ob-eyebrow">{t('documents.designer.templates')}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
          {DOCUMENT_TYPES.map((value) => (
            <button
              key={value}
              type="button"
              className="ob-pdfdesigner-typerow"
              aria-pressed={draft.documentType === value}
              disabled={!canSave}
              onClick={() => changeType(value)}
            >
              <span className="ob-body-strong">{t(DOCUMENT_TYPE_KEY[value])}</span>
              <span className="ob-small">{t(DESIGNER_TYPE_HINT[value])}</span>
            </button>
          ))}
        </div>

        <div className="ob-eyebrow" style={{ marginTop: 'var(--s-16)' }}>
          {t('documents.designer.blocks')}
        </div>
        <p className="ob-small" style={{ margin: 0 }}>
          {t('documents.designer.blocksHint')}
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
          {DESIGNER_BLOCKS.map((kind) => (
            <button
              key={kind}
              type="button"
              className="ob-pdfdesigner-blockrow"
              draggable={canSave}
              disabled={!canSave}
              onDragStart={(event) => {
                event.dataTransfer.setData('application/x-ob-block', kind);
                event.dataTransfer.effectAllowed = 'copy';
              }}
              onClick={() => placeBlock(kind)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') placeBlock(kind);
              }}
            >
              <Icon name="drag" size={14} />
              <span>{t(BLOCK_LABEL_KEY[kind])}</span>
            </button>
          ))}
        </div>
      </aside>

      <div
        ref={stageRef}
        className="ob-pdfdesigner-stage"
        onDragOver={(event) => {
          if (!canSave) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }}
        onDrop={(event) => {
          if (!canSave) return;
          const kind = event.dataTransfer.getData('application/x-ob-block') as DocumentBlockKind;
          if (!kind || !DESIGNER_BLOCKS.includes(kind)) return;
          event.preventDefault();
          placeBlock(kind, pointFromDrop(event) ?? undefined);
        }}
      >
        {layout.elements.length > 0 ? (
          canSave ? (
            <PageDesigner
              geometry={geometry}
              layout={layout}
              bindings={bindings}
              onChange={onLayout}
              pendingInsert={insertion}
              insertElements={insertElements}
              onInsertConsumed={onInsertConsumed}
            />
          ) : (
            <div style={{ maxWidth: rem(420), margin: '0 auto' }}>
              <PageDesignerCanvas geometry={geometry} elements={layout.elements} />
            </div>
          )
        ) : (
          <p className="ob-small">{t('documents.preview.noSubjects')}</p>
        )}
      </div>

      <aside className="ob-pdfdesigner-rail" aria-label={t('documents.designer.options')}>
        <DesignerPreviewHead draft={draft} canRender={canRender} busy={busy} canSave={canSave} save={save} onCancel={onCancel} transport={transport} />
        <div className="ob-eyebrow">{t('documents.designer.options')}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
          {TOGGLE_GROUPS.flatMap((group) => group.keys)
            .filter((key) => showMoney || key !== 'showRates')
            .map((key) => (
              <Checkbox
                key={key}
                checked={Boolean(draft[key])}
                disabled={!canSave}
                label={t(TOGGLE_LABEL_KEY[key])}
                onChange={(next) => {
                  if (key === 'showWatermark' && next && !(draft.watermarkText ?? '').trim()) {
                    set('watermarkText', 'DRAFT');
                  }
                  set(key, next);
                }}
              />
            ))}
        </div>
        {(draft.showRates || showMoney) && (
          <p className="ob-small" style={{ margin: 0 }}>
            {t('documents.designer.ratesHint')}
          </p>
        )}

        <div className="ob-eyebrow" style={{ marginTop: 'var(--s-12)' }}>
          {t('documents.designer.margins')}
        </div>
        <Segmented<MarginPreset | 'custom'>
          value={marginPreset ?? 'custom'}
          onChange={(next) => {
            if (next === 'custom') return;
            set('margins', { ...MARGIN_PRESETS[next] });
          }}
          options={
            marginPreset
              ? [
                  { value: 'narrow' as const, label: t('documents.designer.margin.narrow') },
                  { value: 'normal' as const, label: t('documents.designer.margin.normal') },
                  { value: 'wide' as const, label: t('documents.designer.margin.wide') },
                ]
              : [
                  { value: 'narrow' as const, label: t('documents.designer.margin.narrow') },
                  { value: 'normal' as const, label: t('documents.designer.margin.normal') },
                  { value: 'wide' as const, label: t('documents.designer.margin.wide') },
                  { value: 'custom' as const, label: t('documents.designer.margin.custom') },
                ]
          }
        />

        <div className="ob-eyebrow" style={{ marginTop: 'var(--s-12)' }}>
          {t('documents.designer.paper')}
        </div>
        <Segmented<PaperSize>
          value={(draft.paperSize ?? 'A4') as PaperSize}
          onChange={(next) => set('paperSize', next)}
          options={[
            { value: 'A4', label: 'A4' },
            { value: 'A5', label: 'A5' },
          ]}
        />

        <button
          type="button"
          className="ob-pdfdesigner-more"
          aria-expanded={showMore}
          onClick={() => setShowMore((current) => !current)}
        >
          {t('documents.designer.moreSettings')}
        </button>
        {showMore && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-12)' }}>
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
            <div
              style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--s-8)' }}
            >
              {(['top', 'right', 'bottom', 'left'] as const).map((edge) => (
                <FormField key={edge} label={t(`documents.editor.margin.${edge}`)}>
                  {(id) => (
                    <NumberInput
                      id={id}
                      value={String(margins[edge])}
                      disabled={!canSave}
                      onChange={(event) => {
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
        )}
      </aside>
    </div>
  );
}
function designerBindings(
  customFields: CustomFieldDefinition[],
  showMoney: boolean,
): ReturnType<typeof bindingChoices> {
  // The catalogue the palette offers. Built here rather than fetched: these are
  // the bindings this product has, and a list that arrived over the wire could
  // disagree with the one the renderer will actually resolve.
  return bindingChoices(
        [
          { binding: 'company.name', label: t('designer.binding.companyName'), group: 'Company' },
          { binding: 'document.title', label: t('designer.binding.title'), group: 'Document' },
          {
            binding: 'document.reference',
            label: t('designer.binding.reference'),
            group: 'Document',
          },
          {
            binding: 'document.issuedOn',
            label: t('designer.binding.issuedOn'),
            group: 'Document',
          },
          { binding: 'document.terms', label: t('designer.binding.terms'), group: 'Document' },
          { binding: 'document.footer', label: t('designer.binding.footer'), group: 'Document' },
          {
            binding: 'document.boxCount',
            label: t('designer.binding.boxCount'),
            group: 'Document',
          },
          ...(showMoney
            ? [
                {
                  binding: 'document.grandTotal',
                  label: t('designer.binding.grandTotal'),
                  group: 'Document',
                },
              ]
            : []),
          {
            binding: 'document.lineCount',
            label: t('designer.binding.lineCount'),
            group: 'Document',
          },
          { binding: 'party.name', label: t('designer.binding.partyName'), group: 'Party' },
          { binding: 'party.code', label: t('designer.binding.partyCode'), group: 'Party' },
          {
            binding: 'party.addressLines',
            label: t('designer.binding.partyAddress'),
            group: 'Party',
          },
          { binding: 'party.city', label: t('designer.binding.partyCity'), group: 'Party' },
          { binding: 'party.state', label: t('designer.binding.partyState'), group: 'Party' },
          { binding: 'party.pincode', label: t('designer.binding.partyPincode'), group: 'Party' },
          { binding: 'party.phone', label: t('designer.binding.partyPhone'), group: 'Party' },
          { binding: 'party.email', label: t('designer.binding.partyEmail'), group: 'Party' },
          { binding: 'party.gstNumber', label: t('designer.binding.partyGst'), group: 'Party' },
        ],
        /*
         * The fields somebody defined on the Fields screen, so adding one there
         * makes it available here — which is what the owner asked for.
         *
         * Only the three entities a document can reach: a `product` field is
         * per line item, and a line item is a table column, and the column set
         * is a closed union precisely so a rate cannot be invented into it.
         * Inactive definitions are left out because the resolver drops them
         * anyway, and offering a field that will silently not print is worse
         * than not offering it.
         */
        customFields
          .filter(
            (definition) =>
              definition.isActive &&
              (definition.entity === 'lead' ||
                definition.entity === 'order' ||
                definition.entity === 'party'),
          )
          .map((definition) => ({
            entity: definition.entity as 'lead' | 'order' | 'party',
            key: definition.key,
            label: definition.label,
          })),
      );
}

/**
 * Kept as a stub so the diff stays reviewable: the stacked form this named
 * has moved into `DesignerShell`, and deleting the symbol outright would hide
 * that move. Remove once the designer shell has run on both panels.
 */
export function LayoutCard(_props: {
  draft: DocumentTemplateInput;
  onLayout: (layout: DocumentLayoutV2) => void;
  canEdit: boolean;
  customFields: CustomFieldDefinition[];
  showMoney: boolean;
}): null {
  void _props;
  return null;
}

/**
 * The head of the designer's right rail: Preview + Save where the screenshot
 * puts them, with Cancel beside them. `PreviewPanel` below owns the subject
 * loading and the popup-safe open; this is its trigger row.
 */
function DesignerPreviewHead({
  draft,
  canRender,
  busy,
  canSave,
  save,
  onCancel,
  transport,
}: {
  draft: Draft;
  canRender: boolean;
  busy: boolean;
  canSave: boolean;
  save: (overwrite?: boolean) => Promise<void>;
  onCancel: () => void;
  transport: DocumentsTransport;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-8)' }}>
      <PreviewPanel draft={draft} transport={transport} compact canRender={canRender} />
      <div style={{ display: 'flex', gap: 'var(--s-8)' }}>
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
            {t('documents.designer.saveTemplate')}
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
function PreviewPanel({
  draft,
  transport,
  compact = false,
  canRender = true,
}: {
  draft: DocumentTemplateInput;
  transport: DocumentsTransport;
  compact?: boolean;
  canRender?: boolean;
}) {
  // The transport behind a ref, never in a dependency array — see the note in
  // `TemplatesTab`, and `ui/tests/no-transport-dep.test.ts`.
  const transportRef = useRef(transport);
  transportRef.current = transport;

  const [fetched, setFetched] = useState<PreviewSubject[] | null>(null);
  const [unreadable, setUnreadable] = useState(false);
  const [chosen, setChosen] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const loadSubjects = useCallback(async () => {
    setUnreadable(false);
    try {
      // Each panel finds these its own way: the Master reads leads and orders
      // over HTTP, an Office panel has them in the snapshot it already holds.
      setFetched(await transportRef.current.subjects());
    } catch {
      // A refusal is a failure, not an absence. A caller who may not open leads
      // or orders would otherwise be told this company has none, which is a
      // statement about the data rather than about their own permissions.
      setUnreadable(true);
      setFetched([]);
    }
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
      const blob = await transport.preview({
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
      {!compact && (
        <>
          <h3 className="ob-title" style={{ margin: '0 0 var(--s-4)' }}>
            {t('documents.preview.title')}
          </h3>
          <p className="ob-small" style={{ margin: '0 0 var(--s-12)', color: 'var(--fg-secondary)' }}>
            {t('documents.preview.description')}
          </p>
        </>
      )}

      {failure && (
        <div style={{ marginBottom: 'var(--s-12)' }}>
          <ConflictBanner>{failure}</ConflictBanner>
        </div>
      )}

      {subjects === null ? (
        <span className="ob-small">{t('documents.preview.loadingSubjects')}</span>
      ) : unreadable ? (
        compact ? (
          <Button variant="secondary" onClick={() => void loadSubjects()}>
            {t('action.retryNow')}
          </Button>
        ) : (
          <ErrorState
            title={t('documents.preview.subjectsFailed')}
            actionLabel={t('action.retryNow')}
            onAction={() => void loadSubjects()}
          />
        )
      ) : subjects.length === 0 ? (
        <span className="ob-small">{t('documents.preview.noSubjects')}</span>
      ) : compact ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-8)' }}>
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
          </div>
          {canRender && (
            <Button busy={busy} disabled={!subject} onClick={() => void preview()}>
              {t('documents.designer.previewWithRealLead')}
            </Button>
          )}
        </div>
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

function ExportsTab({
  revision,
  transport,
  showMoney,
}: {
  revision: number;
  transport: DocumentsTransport;
  showMoney: boolean;
}) {
  // The transport behind a ref, never in a dependency array — see the note in
  // `TemplatesTab`, and `ui/tests/no-transport-dep.test.ts`.
  const transportRef = useRef(transport);
  transportRef.current = transport;

  const [exports, setExports] = useState<DocumentExport[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [paging, setPaging] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(async () => {
    setFailure(null);
    try {
      const page = await transportRef.current.exports();
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
      const page = await transport.exports({ cursor });
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
    ...(showMoney
      ? [
          {
            key: 'rates',
            header: t('documents.exports.colRates'),
            width: rem(110),
            render: (row: DocumentExport) =>
              row.ratesIncluded ? (
                <StatusPill tone="accent">{t('documents.exports.withRates')}</StatusPill>
              ) : (
                <StatusPill>{t('documents.exports.withoutRates')}</StatusPill>
              ),
          } satisfies DataTableColumn<DocumentExport>,
        ]
      : []),
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
        <ButtonLink href={transport.exportUrl(row.id)} variant="secondary" size="sm">
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
