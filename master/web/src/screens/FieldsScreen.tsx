/**
 * Fields — the three managed vocabularies behind every picker in the product:
 * option-list values, custom-field definitions and pipeline stages
 * (docs/backend-modules/04-API-CONTRACT.md §5).
 *
 * Nothing on this screen destroys data. Removing an option value or a custom
 * field sends the row to the Recycle Bin and leaves the string — or the stored
 * JSONB answer — exactly where it is on every record that already holds it;
 * what changes is only whether it is offered next time. Archiving a stage is
 * not even a soft delete: `leads.stage_id` is a real foreign key, so a stage
 * with live records in it is refused rather than orphaned.
 *
 * `fields.view` reads, `fields.manage` writes. A viewer gets the same three
 * tabs with no write controls rendered at all — a greyed Add button on a
 * permission their role can never gain would be a permanent tease.
 */

import { useCallback, useEffect, useState } from 'react';
import type {
  CustomFieldDefinition,
  CustomFieldEntity,
  CustomFieldType,
  FieldCatalogue,
  FieldSetDefinition,
  FieldUsageBreakdown,
  OptionListItem,
  Pipeline,
  PipelineStage,
} from '@orderbook/shared';

import { api, ApiError, type FieldDifference } from '../api';
import { t } from '../i18n/strings';
import { Button, IconButton } from '../ui/Button';
import { Card, Section } from '../ui/Card';
import { ColourChip, StatusPill } from '../ui/DataDisplay';
import { DataTable, type DataTableColumn } from '../ui/DataTable';
import { FormField, Input, Select, Switch, Textarea } from '../ui/Form';
import { Modal } from '../ui/Modal';
import { ConflictBanner, EmptyState, ErrorState, SkeletonRows } from '../ui/States';
import { Segmented, Tabs, type TabItem } from '../ui/Tabs';

interface Props {
  /** The signed-in caller's own resolved permissions. */
  permissions: string[];
  /** Bumped by the live socket whenever data changes. */
  revision: number;
}

type Tab = 'values' | 'definitions' | 'stages';

/** The server's own rule (`master/src/domain/field-values.ts`), checked here to save a round trip. */
const HEX_PATTERN = /^#[0-9A-Fa-f]{6}$/;
/** Illustrative only — shown in the hint and the error, so they agree. */
const HEX_EXAMPLE = '#c8a165';

/**
 * Declared locally rather than imported from the shared package: every other
 * file in this app takes only *types* across that boundary, and one value
 * import would pull the whole shared barrel — message catalogues included —
 * into the browser bundle for the sake of five strings. The annotation still
 * fails the build if the union gains a member this list does not.
 */
const FIELD_TYPES: CustomFieldType[] = ['text', 'number', 'date', 'select', 'boolean'];

/**
 * `usedBy` and the entity list are server-minted tokens. A token this file has
 * no phrase for falls back to the token itself rather than rendering a raw key
 * path at the reader — a missing label should look like a missing label.
 */
function token(prefix: string, name: string): string {
  const key = `${prefix}.${name}`;
  const text = t(key);
  return text === key ? name : text;
}

/** A reorder submits the whole ordered list, so a move is computed on the array, not as a delta. */
function moved<T>(rows: T[], index: number, delta: number): T[] {
  const next = [...rows];
  const [row] = next.splice(index, 1);
  next.splice(index + delta, 0, row);
  return next;
}

export function FieldsScreen({ permissions, revision }: Props) {
  const canView = permissions.includes('fields.view');
  const canManage = permissions.includes('fields.manage');

  const [tab, setTab] = useState<Tab>('values');
  const [catalogue, setCatalogue] = useState<FieldCatalogue | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // The catalogue is a constant the server builds from code, not data — it is
  // fetched once for the session and deliberately not tied to `revision`.
  const loadCatalogue = useCallback(async () => {
    setLoadError(null);
    try {
      setCatalogue(await api.fieldsCatalogue());
    } catch (caught) {
      setCatalogue(null);
      setLoadError(caught instanceof Error ? caught.message : t('fields.error.load'));
    }
  }, []);

  useEffect(() => {
    if (!canView) return;
    void loadCatalogue();
  }, [canView, loadCatalogue]);

  if (!canView) {
    return (
      <EmptyState
        title={t('fields.noAccess.title')}
        description={t('fields.noAccess.description', { permission: 'fields.view' })}
      />
    );
  }

  const tabItems: TabItem[] = [
    { id: 'values', label: t('fields.tab.values') },
    { id: 'definitions', label: t('fields.tab.definitions') },
    { id: 'stages', label: t('fields.tab.stages') },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h1 className="ob-title" style={{ margin: 0 }}>
          {t('fields.title')}
        </h1>
        <Tabs tabs={tabItems} activeId={tab} onChange={(id) => setTab(id as Tab)} />
      </div>

      {!canManage && (
        <p className="ob-small" style={{ margin: 0 }}>
          {t('fields.readOnly', { permission: 'fields.manage' })}
        </p>
      )}

      {loadError ? (
        <ErrorState
          title={t('fields.error.title')}
          description={loadError}
          actionLabel={t('action.retryNow')}
          onAction={() => void loadCatalogue()}
        />
      ) : !catalogue ? (
        <SkeletonRows rows={5} columns={5} />
      ) : tab === 'values' ? (
        <ValuesTab sets={catalogue.sets} canManage={canManage} revision={revision} />
      ) : tab === 'definitions' ? (
        <DefinitionsTab
          entities={catalogue.customFieldEntities}
          canManage={canManage}
          revision={revision}
        />
      ) : (
        <StagesTab canManage={canManage} revision={revision} />
      )}
    </div>
  );
}

/**
 * A stale save's report, shared by the two editors that carry a version.
 *
 * Nothing is applied automatically: taking the other person's row silently is
 * how their work disappears without anybody being told, and taking ours
 * silently is the same thing in the other direction.
 */
function ConflictNotice({
  message,
  diff,
  onReload,
  onOverwrite,
  busy,
}: {
  message: string;
  diff: Record<string, FieldDifference>;
  onReload: () => void;
  onOverwrite: () => void;
  busy: boolean;
}) {
  const describe = (value: unknown): string => {
    if (value === null || value === undefined || value === '') return t('fields.conflict.notSet');
    return Array.isArray(value) ? value.join(', ') : String(value);
  };

  return (
    <ConflictBanner
      action={
        <div style={{ display: 'flex', gap: 'var(--s-8)' }}>
          <Button variant="secondary" size="sm" onClick={onReload}>
            {t('fields.conflict.reload')}
          </Button>
          <Button size="sm" disabled={busy} onClick={onOverwrite}>
            {t('fields.conflict.overwrite')}
          </Button>
        </div>
      }
    >
      <strong>{message}</strong>
      {Object.keys(diff).length > 0 && (
        <ul style={{ margin: 'var(--s-8) 0 0', paddingLeft: 'var(--s-20)' }}>
          {Object.entries(diff).map(([field, difference]) => (
            <li key={field}>
              <strong>{field}</strong>: {t('fields.conflict.theirs')}{' '}
              <code>{describe(difference.stored)}</code>, {t('fields.conflict.yours')}{' '}
              <code>{describe(difference.incoming)}</code>
            </li>
          ))}
        </ul>
      )}
    </ConflictBanner>
  );
}

/** Six hex digits with a live swatch. Empty clears the colour, which is a valid state. */
function HexField({
  label,
  hint,
  value,
  name,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  name: string;
  onChange: (next: string) => void;
}) {
  const trimmed = value.trim();
  const invalid = trimmed !== '' && !HEX_PATTERN.test(trimmed);

  return (
    <FormField label={label} hint={hint} error={invalid ? t('fields.values.field.hexInvalid', { example: HEX_EXAMPLE }) : undefined}>
      {(id) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-8)' }}>
          <Input
            id={id}
            value={value}
            invalid={invalid}
            placeholder="#c8a165"
            onChange={(event) => onChange(event.target.value)}
          />
          <ColourChip hex={invalid || !trimmed ? undefined : trimmed} name={name} />
        </div>
      )}
    </FormField>
  );
}

// --- Option-list values -----------------------------------------------------

function ValuesTab({
  sets,
  canManage,
  revision,
}: {
  sets: FieldSetDefinition[];
  canManage: boolean;
  revision: number;
}) {
  const [listKey, setListKey] = useState<string>(sets[0]?.listKey ?? '');
  const [items, setItems] = useState<OptionListItem[]>([]);
  const [usage, setUsage] = useState<FieldUsageBreakdown | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editing, setEditing] = useState<OptionListItem | null>(null);
  const [creating, setCreating] = useState<{ value: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<OptionListItem | null>(null);

  const set = sets.find((candidate) => candidate.listKey === listKey) ?? null;

  const load = useCallback(async () => {
    if (!listKey) return;
    setLoading(true);
    setLoadError(null);
    try {
      // Usage rides along with the list: "is anything actually using this?" is
      // the question that decides whether a value may be retired, and it is
      // also where values that exist only on records — never configured here —
      // are discovered.
      const [values, breakdown] = await Promise.all([
        api.fieldValues(listKey),
        api.fieldUsage(listKey),
      ]);
      setItems(values.items);
      setUsage(breakdown);
    } catch (caught) {
      setItems([]);
      setUsage(null);
      setLoadError(caught instanceof Error ? caught.message : t('fields.error.load'));
    } finally {
      setLoading(false);
    }
  }, [listKey]);

  useEffect(() => {
    void load();
  }, [load, revision]);

  async function run(action: () => Promise<unknown>, failure: string): Promise<void> {
    setActionError(null);
    try {
      await action();
      await load();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : failure);
    }
  }

  function move(index: number, delta: number): void {
    if (!set) return;
    const ids = moved(items, index, delta).map((item) => item.id);
    void run(
      () => api.reorderFieldValues({ listKey: set.listKey, ids }),
      t('fields.error.reorder'),
    );
  }

  if (!set) {
    return <EmptyState title={t('fields.values.empty.title')} />;
  }

  const usageFor = (value: string) => usage?.values.find((entry) => entry.value === value) ?? null;

  const columns: DataTableColumn<OptionListItem>[] = [
    ...(canManage
      ? [
          {
            key: 'order',
            header: t('fields.col.order'),
            width: '72px',
            render: (item: OptionListItem) => {
              const index = items.indexOf(item);
              return (
                <span style={{ display: 'flex', gap: 'var(--s-2)' }}>
                  <IconButton
                    icon="chevron-up"
                    label={t('fields.action.moveUp')}
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  />
                  <IconButton
                    icon="chevron-down"
                    label={t('fields.action.moveDown')}
                    disabled={index === items.length - 1}
                    onClick={() => move(index, 1)}
                  />
                </span>
              );
            },
          },
        ]
      : []),
    ...(set.hasHex
      ? [
          {
            key: 'colour',
            header: t('fields.values.col.colour'),
            width: '80px',
            render: (item: OptionListItem) => (
              <ColourChip hex={item.hex ?? undefined} name={item.label} />
            ),
          },
        ]
      : []),
    {
      key: 'value',
      header: t('fields.values.col.value'),
      width: '200px',
      render: (item) => <span className="ob-mono">{item.value}</span>,
    },
    {
      key: 'label',
      header: t('fields.values.col.label'),
      render: (item) => item.label,
    },
    {
      key: 'status',
      header: t('fields.values.col.status'),
      width: '110px',
      render: (item) =>
        item.isActive ? (
          <StatusPill tone="ok">{t('fields.status.active')}</StatusPill>
        ) : (
          <StatusPill tone="offline">{t('fields.status.inactive')}</StatusPill>
        ),
    },
    {
      key: 'usage',
      header: t('fields.values.col.usage'),
      width: '110px',
      align: 'right',
      render: (item) => {
        const entry = usageFor(item.value);
        // The source names come from the server as plain strings, not tokens
        // (`field-usage.repository.ts`), so they are shown as they arrive.
        const breakdown = entry
          ? Object.entries(entry.bySource)
              .map(([source, count]) => `${source}: ${count}`)
              .join('\n')
          : undefined;
        return <span title={breakdown}>{entry?.total ?? 0}</span>;
      },
    },
    ...(canManage
      ? [
          {
            key: 'actions',
            header: '',
            width: '170px',
            render: (item: OptionListItem) => (
              <div style={{ display: 'flex', gap: 'var(--s-6)', justifyContent: 'flex-end', width: '100%' }}>
                <Button variant="secondary" size="sm" onClick={() => setEditing(item)}>
                  {t('fields.action.edit')}
                </Button>
                <Button variant="danger" size="sm" onClick={() => setConfirmRemove(item)}>
                  {t('fields.action.remove')}
                </Button>
              </div>
            ),
          },
        ]
      : []),
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
      <Segmented
        options={sets.map((candidate) => ({
          value: candidate.listKey as string,
          label: t(candidate.labelToken),
        }))}
        value={listKey}
        onChange={setListKey}
      />

      {actionError && <ConflictBanner>{actionError}</ConflictBanner>}

      <Section
        title={t(set.labelToken)}
        action={
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-8)' }}>
            <span className="ob-small">
              {t('fields.usedBy.label', {
                sources: set.usedBy.map((name) => token('fields.usedBy', name)).join(', '),
              })}
            </span>
            {canManage && (
              <Button variant="primary" size="sm" icon="plus" onClick={() => setCreating({ value: '' })}>
                {t('fields.values.add')}
              </Button>
            )}
          </div>
        }
      >
        {loading ? (
          <SkeletonRows rows={5} columns={4} />
        ) : loadError ? (
          <ErrorState
            title={t('fields.error.title')}
            description={`${loadError} — ${t('fields.values.error.description')}`}
            actionLabel={t('action.retryNow')}
            onAction={() => void load()}
          />
        ) : (
          <DataTable
            columns={columns}
            rows={items}
            rowKey={(item) => item.id}
            empty={
              <EmptyState
                title={t('fields.values.empty.title')}
                description={t('fields.values.empty.description')}
              />
            }
          />
        )}
      </Section>

      {/* Values that exist on records with no row here. They keep rendering
          wherever they sit — what they cannot do is be picked again. */}
      {usage && usage.unlisted.length > 0 && (
        <Card>
          <div className="ob-eyebrow">{t('fields.values.unlisted.title')}</div>
          <p className="ob-small" style={{ margin: 'var(--s-6) 0 var(--s-8)' }}>
            {t('fields.values.unlisted.description')}
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s-6)' }}>
            {usage.unlisted.map((entry) =>
              canManage ? (
                <Button
                  key={entry.value}
                  variant="secondary"
                  size="sm"
                  icon="plus"
                  onClick={() => setCreating({ value: entry.value })}
                >
                  {t('fields.values.unlisted.item', { value: entry.value, count: entry.total })}
                </Button>
              ) : (
                <StatusPill key={entry.value}>
                  {t('fields.values.unlisted.item', { value: entry.value, count: entry.total })}
                </StatusPill>
              ),
            )}
          </div>
        </Card>
      )}

      {(editing || creating) && (
        <ValueDialog
          // A fresh instance per row: the dialog seeds its draft from the row
          // it was opened on, so reusing one would edit A's draft against B.
          key={editing?.id ?? 'new'}
          set={set}
          item={editing}
          initialValue={creating?.value ?? ''}
          onClose={() => {
            setEditing(null);
            setCreating(null);
          }}
          onSaved={() => {
            setEditing(null);
            setCreating(null);
            void load();
          }}
        />
      )}

      <Modal
        open={Boolean(confirmRemove)}
        onClose={() => setConfirmRemove(null)}
        title={confirmRemove ? t('fields.values.delete.title', { label: confirmRemove.label }) : ''}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmRemove(null)}>
              {t('fields.action.cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                const target = confirmRemove;
                setConfirmRemove(null);
                if (target) void run(() => api.deleteFieldValue(target.id), t('fields.error.delete'));
              }}
            >
              {t('fields.action.remove')}
            </Button>
          </>
        }
      >
        <p className="ob-body">
          {confirmRemove && t('fields.values.delete.body', { value: confirmRemove.value })}
        </p>
      </Modal>
    </div>
  );
}

/**
 * Create and edit in one dialog: they differ only in whether `value` is being
 * minted or is already the identity records hold, and offering an edit control
 * the server refuses would be worse than either.
 */
function ValueDialog({
  set,
  item,
  initialValue,
  onClose,
  onSaved,
}: {
  set: FieldSetDefinition;
  item: OptionListItem | null;
  initialValue: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const [label, setLabel] = useState(item?.label ?? '');
  const [hex, setHex] = useState(item?.hex ?? '');
  const [isActive, setIsActive] = useState(item?.isActive ?? true);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ message: string; diff: Record<string, FieldDifference> } | null>(
    null,
  );
  // Re-based only by an explicit Overwrite — see `ConflictNotice`.
  const [baseVersion, setBaseVersion] = useState(item?.version ?? 0);

  const trimmedHex = hex.trim();
  const hexInvalid = trimmedHex !== '' && !HEX_PATTERN.test(trimmedHex);
  const ready = !busy && !hexInvalid && (item ? label.trim() !== '' : value.trim() !== '');

  async function save(overwrite = false): Promise<void> {
    setBusy(true);
    setFailure(null);
    setConflict(null);
    try {
      if (item) {
        await api.updateFieldValue(item.id, {
          label: label.trim(),
          ...(set.hasHex ? { hex: trimmedHex || null } : {}),
          isActive,
          expectedVersion: overwrite ? baseVersion : item.version,
        });
      } else {
        await api.createFieldValue({
          listKey: set.listKey,
          value: value.trim(),
          label: label.trim() || value.trim(),
          hex: set.hasHex ? trimmedHex || null : null,
        });
      }
      onSaved();
    } catch (caught) {
      if (caught instanceof ApiError && caught.isConflict && caught.storedVersion !== undefined) {
        setBaseVersion(caught.storedVersion);
        setConflict({ message: caught.message, diff: caught.diff });
      } else {
        setFailure(caught instanceof Error ? caught.message : t('fields.error.save'));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={
        item
          ? t('fields.values.edit.title', { label: item.label })
          : t('fields.values.new.title', { set: t(set.labelToken) })
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('fields.action.cancel')}
          </Button>
          <Button variant="primary" busy={busy} disabled={!ready} onClick={() => void save()}>
            {item ? t('fields.action.save') : t('fields.action.create')}
          </Button>
        </>
      }
    >
      {failure && <ConflictBanner>{failure}</ConflictBanner>}

      {conflict && (
        <ConflictNotice
          message={conflict.message}
          diff={conflict.diff}
          busy={busy}
          onReload={onSaved}
          onOverwrite={() => void save(true)}
        />
      )}

      {item ? (
        <FormField label={t('fields.values.field.value')} hint={t('fields.values.field.valueLocked')}>
          {(id) => (
            <p id={id} className="ob-mono" style={{ margin: 0 }}>
              {item.value}
            </p>
          )}
        </FormField>
      ) : (
        <FormField label={t('fields.values.field.value')} hint={t('fields.values.field.valueHint')} required>
          {(id) => (
            <Input id={id} value={value} autoFocus onChange={(event) => setValue(event.target.value)} />
          )}
        </FormField>
      )}

      <FormField label={t('fields.values.field.label')} hint={t('fields.values.field.labelHint')}>
        {(id) => <Input id={id} value={label} onChange={(event) => setLabel(event.target.value)} />}
      </FormField>

      {set.hasHex && (
        <HexField
          label={t('fields.values.field.hex')}
          hint={t('fields.values.field.hexHint', { example: HEX_EXAMPLE })}
          value={hex}
          name={label || value || set.listKey}
          onChange={setHex}
        />
      )}

      {item && (
        <FormField label={t('fields.values.field.active')} hint={t('fields.values.field.activeHint')}>
          {() => (
            <Switch
              checked={isActive}
              onChange={setIsActive}
              label={isActive ? t('fields.status.active') : t('fields.status.inactive')}
            />
          )}
        </FormField>
      )}
    </Modal>
  );
}

// --- Custom-field definitions ------------------------------------------------

function DefinitionsTab({
  entities,
  canManage,
  revision,
}: {
  entities: CustomFieldEntity[];
  canManage: boolean;
  revision: number;
}) {
  const [entity, setEntity] = useState<string>(entities[0] ?? 'lead');
  const [definitions, setDefinitions] = useState<CustomFieldDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editing, setEditing] = useState<CustomFieldDefinition | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<CustomFieldDefinition | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setDefinitions(await api.fieldDefinitions({ entity }));
    } catch (caught) {
      setDefinitions([]);
      setLoadError(caught instanceof Error ? caught.message : t('fields.error.load'));
    } finally {
      setLoading(false);
    }
  }, [entity]);

  useEffect(() => {
    void load();
  }, [load, revision]);

  async function run(action: () => Promise<unknown>, failure: string): Promise<void> {
    setActionError(null);
    try {
      await action();
      await load();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : failure);
    }
  }

  function move(index: number, delta: number): void {
    const ids = moved(definitions, index, delta).map((definition) => definition.id);
    void run(
      () => api.reorderFieldDefinitions({ entity: entity as CustomFieldEntity, ids }),
      t('fields.error.reorder'),
    );
  }

  const columns: DataTableColumn<CustomFieldDefinition>[] = [
    ...(canManage
      ? [
          {
            key: 'order',
            header: t('fields.col.order'),
            width: '72px',
            render: (definition: CustomFieldDefinition) => {
              const index = definitions.indexOf(definition);
              return (
                <span style={{ display: 'flex', gap: 'var(--s-2)' }}>
                  <IconButton
                    icon="chevron-up"
                    label={t('fields.action.moveUp')}
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  />
                  <IconButton
                    icon="chevron-down"
                    label={t('fields.action.moveDown')}
                    disabled={index === definitions.length - 1}
                    onClick={() => move(index, 1)}
                  />
                </span>
              );
            },
          },
        ]
      : []),
    {
      key: 'key',
      header: t('fields.definitions.col.key'),
      width: '180px',
      render: (definition) => <span className="ob-mono">{definition.key}</span>,
    },
    {
      key: 'label',
      header: t('fields.definitions.col.label'),
      render: (definition) => definition.label,
    },
    {
      key: 'type',
      header: t('fields.definitions.col.type'),
      width: '110px',
      render: (definition) => t(`fields.type.${definition.fieldType}`),
    },
    {
      key: 'required',
      header: t('fields.definitions.col.required'),
      width: '100px',
      render: (definition) =>
        definition.isRequired ? (
          <StatusPill tone="accent">{t('fields.definitions.requiredYes')}</StatusPill>
        ) : (
          <span className="ob-small">{t('fields.definitions.requiredNo')}</span>
        ),
    },
    {
      key: 'options',
      header: t('fields.definitions.col.options'),
      render: (definition) => (
        // The row is one `--row-h` tall and clips, so the full set rides on the
        // title rather than wrapping into a height the cell does not have.
        <span
          title={definition.options.join('\n')}
          style={{ minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
        >
          {definition.options.join(', ') || '—'}
        </span>
      ),
    },
    {
      key: 'status',
      header: t('fields.values.col.status'),
      width: '110px',
      render: (definition) =>
        definition.isActive ? (
          <StatusPill tone="ok">{t('fields.status.active')}</StatusPill>
        ) : (
          <StatusPill tone="offline">{t('fields.status.inactive')}</StatusPill>
        ),
    },
    ...(canManage
      ? [
          {
            key: 'actions',
            header: '',
            width: '170px',
            render: (definition: CustomFieldDefinition) => (
              <div style={{ display: 'flex', gap: 'var(--s-6)', justifyContent: 'flex-end', width: '100%' }}>
                <Button variant="secondary" size="sm" onClick={() => setEditing(definition)}>
                  {t('fields.action.edit')}
                </Button>
                <Button variant="danger" size="sm" onClick={() => setConfirmRemove(definition)}>
                  {t('fields.action.remove')}
                </Button>
              </div>
            ),
          },
        ]
      : []),
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
      <Segmented
        options={entities.map((candidate) => ({
          value: candidate as string,
          label: token('fields.entity', candidate),
        }))}
        value={entity}
        onChange={setEntity}
      />

      {actionError && <ConflictBanner>{actionError}</ConflictBanner>}

      <Section
        title={token('fields.entity', entity)}
        action={
          canManage && (
            <Button variant="primary" size="sm" icon="plus" onClick={() => setCreating(true)}>
              {t('fields.definitions.add')}
            </Button>
          )
        }
      >
        {loading ? (
          <SkeletonRows rows={5} columns={5} />
        ) : loadError ? (
          <ErrorState
            title={t('fields.error.title')}
            description={`${loadError} — ${t('fields.definitions.error.description')}`}
            actionLabel={t('action.retryNow')}
            onAction={() => void load()}
          />
        ) : (
          <DataTable
            columns={columns}
            rows={definitions}
            rowKey={(definition) => definition.id}
            empty={
              <EmptyState
                title={t('fields.definitions.empty.title', {
                  entity: token('fields.entity', entity),
                })}
                description={t('fields.definitions.empty.description')}
              />
            }
          />
        )}
      </Section>

      {(editing || creating) && (
        <DefinitionDialog
          key={editing?.id ?? 'new'}
          entity={entity as CustomFieldEntity}
          definition={editing}
          onClose={() => {
            setEditing(null);
            setCreating(false);
          }}
          onSaved={() => {
            setEditing(null);
            setCreating(false);
            void load();
          }}
        />
      )}

      <Modal
        open={Boolean(confirmRemove)}
        onClose={() => setConfirmRemove(null)}
        title={
          confirmRemove ? t('fields.definitions.delete.title', { label: confirmRemove.label }) : ''
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmRemove(null)}>
              {t('fields.action.cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                const target = confirmRemove;
                setConfirmRemove(null);
                if (target) {
                  void run(() => api.deleteFieldDefinition(target.id), t('fields.error.delete'));
                }
              }}
            >
              {t('fields.action.remove')}
            </Button>
          </>
        }
      >
        <p className="ob-body">
          {confirmRemove && t('fields.definitions.delete.body', { key: confirmRemove.key })}
        </p>
      </Modal>
    </div>
  );
}

function DefinitionDialog({
  entity,
  definition,
  onClose,
  onSaved,
}: {
  entity: CustomFieldEntity;
  definition: CustomFieldDefinition | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [key, setKey] = useState('');
  const [label, setLabel] = useState(definition?.label ?? '');
  const [fieldType, setFieldType] = useState<CustomFieldType>(definition?.fieldType ?? 'text');
  const [isRequired, setIsRequired] = useState(definition?.isRequired ?? false);
  const [isActive, setIsActive] = useState(definition?.isActive ?? true);
  const [optionText, setOptionText] = useState((definition?.options ?? []).join('\n'));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ message: string; diff: Record<string, FieldDifference> } | null>(
    null,
  );
  const [baseVersion, setBaseVersion] = useState(definition?.version ?? 0);

  const options = optionText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const needsOptions = fieldType === 'select';
  const ready =
    !busy &&
    (definition ? label.trim() !== '' : key.trim() !== '') &&
    (!needsOptions || options.length > 0);

  async function save(overwrite = false): Promise<void> {
    setBusy(true);
    setFailure(null);
    setConflict(null);
    try {
      if (definition) {
        await api.updateFieldDefinition(definition.id, {
          label: label.trim(),
          isRequired,
          ...(definition.fieldType === 'select' ? { options } : {}),
          isActive,
          expectedVersion: overwrite ? baseVersion : definition.version,
        });
      } else {
        await api.createFieldDefinition({
          entity,
          key: key.trim(),
          label: label.trim() || key.trim(),
          fieldType,
          isRequired,
          ...(needsOptions ? { options } : {}),
        });
      }
      onSaved();
    } catch (caught) {
      if (caught instanceof ApiError && caught.isConflict && caught.storedVersion !== undefined) {
        setBaseVersion(caught.storedVersion);
        setConflict({ message: caught.message, diff: caught.diff });
      } else {
        setFailure(caught instanceof Error ? caught.message : t('fields.error.save'));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={
        definition
          ? t('fields.definitions.edit.title', { label: definition.label })
          : t('fields.definitions.new.title', { entity: token('fields.entity', entity) })
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('fields.action.cancel')}
          </Button>
          <Button variant="primary" busy={busy} disabled={!ready} onClick={() => void save()}>
            {definition ? t('fields.action.save') : t('fields.action.create')}
          </Button>
        </>
      }
    >
      {failure && <ConflictBanner>{failure}</ConflictBanner>}

      {conflict && (
        <ConflictNotice
          message={conflict.message}
          diff={conflict.diff}
          busy={busy}
          onReload={onSaved}
          onOverwrite={() => void save(true)}
        />
      )}

      {definition ? (
        <FormField label={t('fields.definitions.field.key')} hint={t('fields.definitions.field.keyLocked')}>
          {(id) => (
            <p id={id} className="ob-mono" style={{ margin: 0 }}>
              {definition.key}
            </p>
          )}
        </FormField>
      ) : (
        <FormField label={t('fields.definitions.field.key')} hint={t('fields.definitions.field.keyHint')} required>
          {(id) => <Input id={id} value={key} autoFocus onChange={(event) => setKey(event.target.value)} />}
        </FormField>
      )}

      <FormField label={t('fields.definitions.field.label')}>
        {(id) => <Input id={id} value={label} onChange={(event) => setLabel(event.target.value)} />}
      </FormField>

      <FormField
        label={t('fields.definitions.field.type')}
        hint={definition ? t('fields.definitions.field.typeLocked') : undefined}
      >
        {(id) =>
          definition ? (
            <p id={id} style={{ margin: 0 }}>
              {t(`fields.type.${definition.fieldType}`)}
            </p>
          ) : (
            <Select
              id={id}
              value={fieldType}
              onChange={(event) => setFieldType(event.target.value as CustomFieldType)}
            >
              {FIELD_TYPES.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {t(`fields.type.${candidate}`)}
                </option>
              ))}
            </Select>
          )
        }
      </FormField>

      {(definition ? definition.fieldType === 'select' : needsOptions) && (
        <FormField label={t('fields.definitions.field.options')} hint={t('fields.definitions.field.optionsHint')}>
          {(id) => (
            <Textarea
              id={id}
              rows={4}
              value={optionText}
              onChange={(event) => setOptionText(event.target.value)}
            />
          )}
        </FormField>
      )}

      <FormField label={t('fields.definitions.field.required')} hint={t('fields.definitions.field.requiredHint')}>
        {() => (
          <Switch
            checked={isRequired}
            onChange={setIsRequired}
            label={
              isRequired ? t('fields.definitions.requiredYes') : t('fields.definitions.requiredNo')
            }
          />
        )}
      </FormField>

      {definition && (
        <FormField label={t('fields.definitions.field.active')}>
          {() => (
            <Switch
              checked={isActive}
              onChange={setIsActive}
              label={isActive ? t('fields.status.active') : t('fields.status.inactive')}
            />
          )}
        </FormField>
      )}
    </Modal>
  );
}

// --- Pipeline stages ---------------------------------------------------------

function StagesTab({ canManage, revision }: { canManage: boolean; revision: number }) {
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /** An archive the server refused, spelled out — the two refusals mean different things. */
  const [refusal, setRefusal] = useState<string | null>(null);
  const [editing, setEditing] = useState<PipelineStage | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setPipelines(await api.fieldStages());
    } catch (caught) {
      setPipelines([]);
      setLoadError(caught instanceof Error ? caught.message : t('fields.error.load'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, revision]);

  async function run(action: () => Promise<unknown>, failure: string): Promise<void> {
    setActionError(null);
    setRefusal(null);
    try {
      await action();
      await load();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : failure);
    }
  }

  /**
   * Archiving is refused two ways, and the difference is the whole point:
   * the default stage can never be archived, while an occupied one only cannot
   * be archived *yet*. Reporting either as "could not archive" would hide which
   * of the two the operator is looking at, and what to do about it.
   */
  async function archive(stage: PipelineStage): Promise<void> {
    setActionError(null);
    setRefusal(null);
    try {
      await api.archiveFieldStage(stage.id);
      await load();
    } catch (caught) {
      if (!(caught instanceof ApiError) || !caught.isConflict) {
        setActionError(caught instanceof Error ? caught.message : t('fields.error.save'));
        return;
      }

      if (caught.details.field === 'isDefault') {
        setRefusal(t('fields.stages.refusal.default'));
        return;
      }

      const occupancy = caught.details.occupiedBy as { leads: number; orders: number } | undefined;
      if (!occupancy) {
        setActionError(caught.message);
        return;
      }

      const targetId = caught.details.suggestedTarget as string | null;
      const target = pipelines
        .flatMap((pipeline) => pipeline.stages)
        .find((candidate) => candidate.id === targetId);

      setRefusal(
        [
          t('fields.stages.refusal.occupied', {
            stage: stage.name,
            leads: occupancy.leads,
            orders: occupancy.orders,
          }),
          target ? t('fields.stages.refusal.moveTo', { target: target.name }) : '',
        ]
          .filter(Boolean)
          .join(' '),
      );
    }
  }

  function columnsFor(stages: PipelineStage[]): DataTableColumn<PipelineStage>[] {
    return [
      ...(canManage
        ? [
            {
              key: 'order',
              header: t('fields.col.order'),
              width: '72px',
              render: (stage: PipelineStage) => {
                const index = stages.indexOf(stage);
                return (
                  <span style={{ display: 'flex', gap: 'var(--s-2)' }}>
                    <IconButton
                      icon="chevron-up"
                      label={t('fields.action.moveUp')}
                      disabled={index === 0}
                      onClick={() =>
                        void run(
                          () =>
                            api.reorderFieldStages({
                              pipelineId: stage.pipelineId,
                              // Archived stages keep their place in the sequence,
                              // so the submitted list is every stage of the
                              // pipeline — a partial list is rejected outright.
                              ids: moved(stages, index, -1).map((row) => row.id),
                            }),
                          t('fields.error.reorder'),
                        )
                      }
                    />
                    <IconButton
                      icon="chevron-down"
                      label={t('fields.action.moveDown')}
                      disabled={index === stages.length - 1}
                      onClick={() =>
                        void run(
                          () =>
                            api.reorderFieldStages({
                              pipelineId: stage.pipelineId,
                              ids: moved(stages, index, 1).map((row) => row.id),
                            }),
                          t('fields.error.reorder'),
                        )
                      }
                    />
                  </span>
                );
              },
            },
          ]
        : []),
      {
        key: 'colour',
        header: t('fields.stages.col.colour'),
        width: '80px',
        render: (stage) => <ColourChip hex={stage.colour ?? undefined} name={stage.name} />,
      },
      {
        key: 'name',
        header: t('fields.stages.col.name'),
        render: (stage) => stage.name,
      },
      {
        key: 'flags',
        header: t('fields.stages.col.flags'),
        width: '260px',
        render: (stage) => (
          <span style={{ display: 'flex', gap: 'var(--s-6)' }}>
            {stage.isDefault && <StatusPill tone="accent">{t('fields.stages.flag.default')}</StatusPill>}
            {stage.isTerminal && <StatusPill tone="ok">{t('fields.stages.flag.terminal')}</StatusPill>}
            {stage.isArchived && (
              <StatusPill tone="offline">{t('fields.stages.flag.archived')}</StatusPill>
            )}
          </span>
        ),
      },
      ...(canManage
        ? [
            {
              key: 'actions',
              header: '',
              width: '300px',
              render: (stage: PipelineStage) => (
                <div style={{ display: 'flex', gap: 'var(--s-6)', justifyContent: 'flex-end', width: '100%' }}>
                  <Button variant="secondary" size="sm" onClick={() => setEditing(stage)}>
                    {t('fields.action.edit')}
                  </Button>
                  {!stage.isDefault && !stage.isArchived && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() =>
                        void run(
                          () => api.updateFieldStage(stage.id, { isDefault: true }),
                          t('fields.error.save'),
                        )
                      }
                    >
                      {t('fields.stages.action.makeDefault')}
                    </Button>
                  )}
                  {stage.isArchived ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() =>
                        void run(() => api.restoreFieldStage(stage.id), t('fields.error.save'))
                      }
                    >
                      {t('fields.stages.action.restore')}
                    </Button>
                  ) : (
                    // Present even on the default stage: hiding it would leave
                    // the reason unexplained, and archiving is reversible.
                    <Button variant="danger" size="sm" onClick={() => void archive(stage)}>
                      {t('fields.stages.action.archive')}
                    </Button>
                  )}
                </div>
              ),
            },
          ]
        : []),
    ];
  }

  if (loading) return <SkeletonRows rows={6} columns={4} />;

  if (loadError) {
    return (
      <ErrorState
        title={t('fields.error.title')}
        description={`${loadError} — ${t('fields.stages.error.description')}`}
        actionLabel={t('action.retryNow')}
        onAction={() => void load()}
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
      <p className="ob-small" style={{ margin: 0 }}>
        {t('fields.stages.description')}
      </p>

      {actionError && <ConflictBanner>{actionError}</ConflictBanner>}
      {refusal && (
        <ConflictBanner
          action={
            <Button size="sm" variant="secondary" onClick={() => setRefusal(null)}>
              {t('action.dismiss')}
            </Button>
          }
        >
          {refusal}
        </ConflictBanner>
      )}

      {/* A read that succeeded and found no pipeline at all is its own state:
          without this it renders as the description paragraph and nothing
          else, which reads like a table that has not finished loading. */}
      {pipelines.length === 0 ? (
        <EmptyState
          title={t('fields.stages.empty.pipelines')}
          description={t('fields.stages.empty.description')}
        />
      ) : (
        pipelines.map((pipeline) => (
          <Section key={pipeline.id} title={pipeline.name}>
            <DataTable
              columns={columnsFor(pipeline.stages)}
              rows={pipeline.stages}
              rowKey={(stage) => stage.id}
              empty={
                <EmptyState
                  title={t('fields.stages.empty.title')}
                  description={t('fields.stages.empty.description')}
                />
              }
            />
          </Section>
        ))
      )}

      {editing && (
        <StageDialog
          stage={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

/**
 * `pipeline_stages` carries no `version` column — it is not a list two people
 * curate concurrently the way option lists are — so this editor has no stale
 * save to report and no `expectedVersion` to send.
 */
function StageDialog({
  stage,
  onClose,
  onSaved,
}: {
  stage: PipelineStage;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(stage.name);
  const [colour, setColour] = useState(stage.colour ?? '');
  const [isTerminal, setIsTerminal] = useState(stage.isTerminal);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const trimmedColour = colour.trim();
  const colourInvalid = trimmedColour !== '' && !HEX_PATTERN.test(trimmedColour);

  async function save(): Promise<void> {
    setBusy(true);
    setFailure(null);
    try {
      await api.updateFieldStage(stage.id, {
        name: name.trim(),
        colourHex: trimmedColour || null,
        isTerminal,
      });
      onSaved();
    } catch (caught) {
      setFailure(caught instanceof Error ? caught.message : t('fields.error.save'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('fields.stages.edit.title', { name: stage.name })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('fields.action.cancel')}
          </Button>
          <Button
            variant="primary"
            busy={busy}
            disabled={busy || colourInvalid || name.trim() === ''}
            onClick={() => void save()}
          >
            {t('fields.action.save')}
          </Button>
        </>
      }
    >
      {failure && <ConflictBanner>{failure}</ConflictBanner>}

      <FormField label={t('fields.stages.field.name')}>
        {(id) => <Input id={id} value={name} autoFocus onChange={(event) => setName(event.target.value)} />}
      </FormField>

      <HexField
        label={t('fields.stages.field.colour')}
        hint={t('fields.values.field.hexHint', { example: HEX_EXAMPLE })}
        value={colour}
        name={name || stage.name}
        onChange={setColour}
      />

      <FormField label={t('fields.stages.field.terminal')} hint={t('fields.stages.field.terminalHint')}>
        {() => (
          <Switch
            checked={isTerminal}
            onChange={setIsTerminal}
            label={t('fields.stages.flag.terminal')}
          />
        )}
      </FormField>
    </Modal>
  );
}
