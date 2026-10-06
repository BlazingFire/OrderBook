/**
 * One option list's values — list, add, edit (label, colour, active), remove,
 * reorder — as a fragment any screen on either panel can mount.
 *
 * It began as the Values tab of the Master's Fields screen. The 2026 catalogue
 * (docs/catalogue/CATALOGUE_MODEL.md) wants the same editor in more places —
 * lead sources under Settings → Leads, brands beside the products — and on
 * both panels, so it takes a **transport**, the pattern `DeveloperPanel`
 * follows. Both panels' api clients already expose these calls under these
 * names (the Office one forwards them to the Master), so a panel's transport
 * is its own methods plus `conflictOf`, which exists because each panel has
 * its own `ApiError`.
 *
 * Nothing here destroys data. Removing a value sends the row to the Recycle
 * Bin — restoring is done there, not here — and leaves the string exactly
 * where it is on every record that already holds it; what changes is only
 * whether it is offered next time. Without `canManage` the same list renders
 * with no write controls at all: a greyed Add button on a permission the
 * reader's role can never gain would be a permanent tease.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  FieldListKey,
  FieldSetDefinition,
  FieldUsageBreakdown,
  OptionListItem,
  OptionListItemInput,
  OptionListItemUpdateInput,
  OptionListReorderInput,
} from '@orderbook/shared';
import { buildFieldCatalogue } from '@orderbook/shared';

import { Button, IconButton } from './Button.js';
import { Card, Section } from './Card.js';
import { ColourChip, StatusPill } from './DataDisplay.js';
import { DataTable, type DataTableColumn } from './DataTable.js';
import { FormField, Input, Switch } from './Form.js';
import { Modal } from './Modal.js';
import { ConflictBanner, EmptyState, ErrorState, SkeletonRows } from './States.js';
import { rem } from './rem.js';
import { t } from './i18n.js';
import { useFormBaseline, useUnsavedWork } from './unsavedWork.js';

/**
 * A field a stale save disagrees with the server about — the shape both
 * panels' `ApiError` reads out of a conflict's `details.diff`. Declared here
 * because the kit cannot import either panel's api module.
 */
export interface FieldDifference {
  stored: unknown;
  incoming: unknown;
}

/**
 * Everything the editor needs from the panel it is mounted in — the Fields
 * endpoints (`/api/fields/values…`, `/api/fields/usage`), named as both api
 * clients already name them.
 */
export interface OptionListTransport {
  fieldValues(listKey: FieldListKey): Promise<{ items: OptionListItem[] }>;
  fieldUsage(listKey: FieldListKey): Promise<FieldUsageBreakdown>;
  createFieldValue(input: OptionListItemInput): Promise<unknown>;
  updateFieldValue(id: string, input: OptionListItemUpdateInput): Promise<unknown>;
  deleteFieldValue(id: string): Promise<unknown>;
  reorderFieldValues(input: OptionListReorderInput): Promise<unknown>;
  /** The panel's own reading of an optimistic-lock failure; null for any other error. */
  conflictOf(
    error: unknown,
  ): { message: string; storedVersion: number; diff: Record<string, FieldDifference> } | null;
}

export interface OptionListEditorProps {
  listKey: FieldListKey;
  /** `fields.manage` — without it nothing that writes is rendered. */
  canManage: boolean;
  transport: OptionListTransport;
  /** Bumped by the live socket whenever data changes; each bump reloads. */
  revision?: number;
  /**
   * Drop the list's own heading (its name and "used by" line) for a host that
   * already titles it — Settings → Leads names its section "Sources".
   */
  compact?: boolean;
}

/** The server's own rule (`master/src/domain/field-values.ts`), checked here to save a round trip. */
export const HEX_PATTERN = /^#[0-9A-Fa-f]{6}$/;
/** Illustrative only — shown in the hint and the error, so they agree. */
export const HEX_EXAMPLE = '#c8a165';

/**
 * The set descriptors, from the same constant the server's
 * `/api/fields/catalogue` is built from — so a host needs only the key, not a
 * catalogue round trip, to mount one list.
 */
const FIELD_SETS = buildFieldCatalogue().sets;

/**
 * `usedBy` names are server-minted tokens. One this file has no phrase for
 * falls back to the token itself rather than rendering a raw key path at the
 * reader — a missing label should look like a missing label.
 */
function usedByLabel(name: string): string {
  const key = `fields.usedBy.${name}`;
  const text = t(key);
  return text === key ? name : text;
}

/** A reorder submits the whole ordered list, so a move is computed on the array, not as a delta. */
function moved<T>(rows: T[], index: number, delta: number): T[] {
  const next = [...rows];
  const [row] = next.splice(index, 1);
  next.splice(index + delta, 0, row as T);
  return next;
}

export function OptionListEditor({
  listKey,
  canManage,
  transport,
  revision = 0,
  compact = false,
}: OptionListEditorProps) {
  const [items, setItems] = useState<OptionListItem[]>([]);
  const [usage, setUsage] = useState<FieldUsageBreakdown | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editing, setEditing] = useState<OptionListItem | null>(null);
  const [creating, setCreating] = useState<{ value: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<OptionListItem | null>(null);

  // Held in a ref, never a dependency — see `ui/tests/no-transport-dep.test.ts`.
  const transportRef = useRef(transport);
  transportRef.current = transport;

  const set = FIELD_SETS.find((candidate) => candidate.listKey === listKey) ?? null;

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      // Usage rides along with the list: "is anything actually using this?" is
      // the question that decides whether a value may be retired, and it is
      // also where values that exist only on records — never configured here —
      // are discovered.
      const [values, breakdown] = await Promise.all([
        transportRef.current.fieldValues(listKey),
        transportRef.current.fieldUsage(listKey),
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
    const ids = moved(items, index, delta).map((item) => item.id);
    void run(() => transport.reorderFieldValues({ listKey, ids }), t('fields.error.reorder'));
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
            header: t('fields.col.position'),
            width: rem(72),
            // Dropped on a narrow screen (1280x720 at 157 %) before Value and
            // Label are squeezed; the row opens the value's editor.
            priority: 2 as const,
            render: (item: OptionListItem) => {
              const index = items.indexOf(item);
              return (
                // Its own clicks, not the row's: an arrow must not open the editor.
                <span
                  style={{ display: 'flex', gap: 'var(--s-2)' }}
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                >
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
            width: rem(80),
            priority: 3 as const,
            render: (item: OptionListItem) => (
              <ColourChip hex={item.hex ?? undefined} name={item.label} />
            ),
          },
        ]
      : []),
    {
      key: 'value',
      header: t('fields.values.col.value'),
      // Value and Label share what the fixed columns leave: a fixed 200 for the
      // value left Label 64 px in Settings at 1080p ("WhatsApp" cut to "Whats…"),
      // and 38 px in Lists at 157 %.
      width: 'minmax(0, 1fr)',
      render: (item) => <span className="ob-mono">{item.value}</span>,
    },
    {
      key: 'label',
      header: t('fields.values.col.label'),
      width: 'minmax(0, 1.4fr)',
      render: (item) => item.label,
    },
    {
      key: 'status',
      header: t('fields.values.col.status'),
      width: rem(110),
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
      width: rem(110),
      priority: 3,
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
            width: rem(170),
            render: (item: OptionListItem) => (
              <div
                style={{
                  display: 'flex',
                  gap: 'var(--s-6)',
                  justifyContent: 'flex-end',
                  width: '100%',
                }}
                // Remove must not also open the editor through the row.
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
              >
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

  const addButton = canManage && (
    <Button variant="primary" size="sm" icon="plus" onClick={() => setCreating({ value: '' })}>
      {t('fields.values.add')}
    </Button>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
      {actionError && <ConflictBanner>{actionError}</ConflictBanner>}

      <Section
        title={compact ? undefined : t(set.labelToken)}
        action={
          compact ? (
            addButton && <div style={{ marginLeft: 'auto' }}>{addButton}</div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-8)' }}>
              <span className="ob-small">
                {t('fields.usedBy.label', { sources: set.usedBy.map(usedByLabel).join(', ') })}
              </span>
              {addButton}
            </div>
          )
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
            // Opening a row edits it, so a column dropped on a narrow screen is one
            // click away (the rule `fitColumns` relies on).
            onRowOpen={canManage ? (item) => setEditing(item) : undefined}
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
          transport={transport}
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
                if (target)
                  void run(() => transport.deleteFieldValue(target.id), t('fields.error.delete'));
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
  transport,
  onClose,
  onSaved,
}: {
  set: FieldSetDefinition;
  item: OptionListItem | null;
  initialValue: string;
  transport: OptionListTransport;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const [label, setLabel] = useState(item?.label ?? '');
  const [hex, setHex] = useState(item?.hex ?? '');
  const [isActive, setIsActive] = useState(item?.isActive ?? true);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{
    message: string;
    diff: Record<string, FieldDifference>;
  } | null>(null);
  // Re-based only by an explicit Overwrite — see `ConflictNotice`.
  const [baseVersion, setBaseVersion] = useState(item?.version ?? 0);
  const baseline = useFormBaseline({
    value: initialValue,
    label: item?.label ?? '',
    hex: item?.hex ?? '',
    isActive: item?.isActive ?? true,
  });

  const trimmedHex = hex.trim();
  const hexInvalid = trimmedHex !== '' && !HEX_PATTERN.test(trimmedHex);
  const ready = !busy && !hexInvalid && (item ? label.trim() !== '' : value.trim() !== '');

  /** True when the value was saved; a clash or a failure is shown in the dialog and answers false. */
  async function save(overwrite = false): Promise<boolean> {
    setBusy(true);
    setFailure(null);
    setConflict(null);
    try {
      if (item) {
        await transport.updateFieldValue(item.id, {
          label: label.trim(),
          ...(set.hasHex ? { hex: trimmedHex || null } : {}),
          isActive,
          expectedVersion: overwrite ? baseVersion : item.version,
        });
      } else {
        await transport.createFieldValue({
          listKey: set.listKey,
          value: value.trim(),
          label: label.trim() || value.trim(),
          hex: set.hasHex ? trimmedHex || null : null,
        });
      }
      onSaved();
      return true;
    } catch (caught) {
      const clash = transport.conflictOf(caught);
      if (clash) {
        setBaseVersion(clash.storedVersion);
        setConflict({ message: clash.message, diff: clash.diff });
      } else {
        setFailure(caught instanceof Error ? caught.message : t('fields.error.save'));
      }
      return false;
    } finally {
      setBusy(false);
    }
  }

  // "Save all and update": a list value being added or changed is saved if it is
  // complete, and named if it is not.
  useUnsavedWork(
    'list-value',
    baseline.dirty({ value, label, hex, isActive })
      ? {
          label: t('updates.saveAll.listValue', { name: label.trim() || value.trim() || '…' }),
          save: async () => (ready ? save() : false),
        }
      : null,
  );

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
        <FormField
          label={t('fields.values.field.value')}
          hint={t('fields.values.field.valueLocked')}
        >
          {(id) => (
            <p id={id} className="ob-mono" style={{ margin: 0 }}>
              {item.value}
            </p>
          )}
        </FormField>
      ) : (
        <FormField
          label={t('fields.values.field.value')}
          hint={t('fields.values.field.valueHint')}
          required
        >
          {(id) => (
            <Input
              id={id}
              value={value}
              autoFocus
              onChange={(event) => setValue(event.target.value)}
            />
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
        <FormField
          label={t('fields.values.field.active')}
          hint={t('fields.values.field.activeHint')}
        >
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

/**
 * A stale save's report — exported because the Fields screen's definition
 * editor carries a version too and reports its clashes the same way.
 *
 * Nothing is applied automatically: taking the other person's row silently is
 * how their work disappears without anybody being told, and taking ours
 * silently is the same thing in the other direction.
 */
export function ConflictNotice({
  message,
  diff,
  onReload,
  onOverwrite,
  busy,
  overwriteLabel,
}: {
  message: string;
  diff: Record<string, FieldDifference>;
  onReload: () => void;
  onOverwrite: () => void;
  busy: boolean;
  /** The pending order form says "Keep mine": its overwrite only re-bases, it does not save. */
  overwriteLabel?: string;
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
            {overwriteLabel ?? t('fields.conflict.overwrite')}
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

/**
 * Six hex digits with a live swatch. Empty clears the colour, which is a valid
 * state. Exported for the Fields screen's stage colour, which follows the same
 * rule.
 */
export function HexField({
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
    <FormField
      label={label}
      hint={hint}
      error={invalid ? t('fields.values.field.hexInvalid', { example: HEX_EXAMPLE }) : undefined}
    >
      {(id) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-8)' }}>
          <Input
            id={id}
            value={value}
            invalid={invalid}
            placeholder={HEX_EXAMPLE}
            onChange={(event) => onChange(event.target.value)}
          />
          <ColourChip hex={invalid || !trimmed ? undefined : trimmed} name={name} />
        </div>
      )}
    </FormField>
  );
}
