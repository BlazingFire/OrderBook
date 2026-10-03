/**
 * Create or edit a party without leaving whatever screen needed one
 * (docs/LEAD_GENERATION_FLOW.md §3.1's "a customer standing at the counter is
 * often new").
 *
 * **Every column the record has, not the five it used to offer.** A form that
 * offers five of a party's fourteen fields is not a shorter form — it is a form
 * that quietly cannot record an address, so somebody writes it in the notes.
 *
 * Lives in `ui/` and takes a **transport**: the two panels reach the same data differently — the
 * Office queues through its offline outbox and gets back an id, the Master
 * writes straight to its own database and gets back the whole record — so this
 * component speaks one narrow interface and never a panel's api client. It was
 * an Office-only component until the Master gained a Parties screen; copying it
 * across would have made every future field a two-file change, which is the
 * drift `master/tests/no-duplicate-ui.test.ts` and the PartyAccess parity test
 * exist to stop.
 *
 * It renders a centred modal: a create/edit form is a dialog, unlike reading a
 * record, which opens on a screen of its own.
 *
 * Props are deliberately generic rather than Add-Lead-specific:
 *
 *   party     — pass one to edit it; omit to create.
 *   onCreated — called once the write is accepted. The Office's write is queued
 *               through the outbox, so the server hands back an id and nothing
 *               else; the caller gets that plus the fields just typed, which is
 *               enough to select the new party immediately.
 *   onUpdated — the caller-typed name, for the confirmation toast.
 */

import { useEffect, useRef, useState } from 'react';
import type { Party, PartyInput } from '@orderbook/shared';

import { Button } from './Button.js';
import { Field, FieldGroup } from './FieldGrid.js';
import { Input, Textarea } from './Form.js';
import { Modal } from './Modal.js';
import { t } from './i18n.js';
import { useCommand } from './KeyboardProvider.js';
import { useEnterToAdvance } from './useEnterToAdvance.js';
import { useFormBaseline, useUnsavedWork } from './unsavedWork.js';

/** What the caller learns about a party that was just created. */
export interface CreatedParty {
  id: string;
  name: string;
  phone: string | null;
  city: string | null;
}

/**
 * Narrow on purpose. A transport that exposed a whole api client would let this
 * component reach for anything, and the two panels' clients are not the same
 * shape — only the two calls below are common to both.
 */
export interface PartyFormTransport {
  /** Resolves to the new party's id. The Office's id is the one its outbox minted. */
  createParty(input: PartyInput): Promise<{ id: string }>;
  /**
   * `baseFieldHlc` is what this screen last saw for each field, so the Master's
   * merge can tell an ordinary sequential edit apart from a real clash.
   */
  updateParty(
    id: string,
    input: PartyInput & { baseFieldHlc?: Record<string, string> },
  ): Promise<unknown>;
}

interface PartyFormModalProps {
  open: boolean;
  transport: PartyFormTransport;
  party?: Party | null;
  onClose: () => void;
  onCreated?: (party: CreatedParty) => void;
  onUpdated?: (name: string) => void;
  onError: (message: string) => void;
}

/** Every text column on a party, so the form and the record cannot drift. */
const EMPTY = {
  name: '',
  phone: '',
  altPhone: '',
  email: '',
  addressLine1: '',
  addressLine2: '',
  city: '',
  state: '',
  pincode: '',
  gstNumber: '',
  notes: '',
};

type Draft = typeof EMPTY;

export function PartyFormModal({
  open,
  transport,
  party,
  onClose,
  onCreated,
  onUpdated,
  onError,
}: PartyFormModalProps) {
  const editing = party ?? null;

  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState(false);
  const baseline = useFormBaseline<Draft>();
  const fields = useRef<HTMLDivElement>(null);
  const transportRef = useRef(transport);
  transportRef.current = transport;

  useEnterToAdvance(fields, () => void save(), open);
  useCommand('record.save', open && !busy ? () => void save() : null);

  const set = (field: keyof Draft, value: string): void =>
    setDraft((current) => ({ ...current, [field]: value }));

  useEffect(() => {
    if (!open) return;

    const loaded = editing
      ? {
          name: editing.name,
          phone: editing.phone ?? '',
          altPhone: editing.altPhone ?? '',
          email: editing.email ?? '',
          addressLine1: editing.addressLine1 ?? '',
          addressLine2: editing.addressLine2 ?? '',
          city: editing.city ?? '',
          state: editing.state ?? '',
          pincode: editing.pincode ?? '',
          gstNumber: editing.gstNumber ?? '',
          notes: editing.notes ?? '',
        }
      : EMPTY;
    baseline.mark(loaded);
    setDraft(loaded);
    // Keyed on the record's identity, not the record: an unrelated field
    // arriving through the event stream must not wipe a half-typed draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing?.id]);

  function close(): void {
    setDraft(EMPTY);
    baseline.mark(EMPTY);
    onClose();
  }

  /** True when the party was saved; false when it was refused or failed (the reason went to `onError`). */
  async function save(): Promise<boolean> {
    const name = draft.name.trim();
    if (!name) {
      onError(t('party.nameRequired'));
      return false;
    }

    const trimmed = (field: keyof Draft): string | null => draft[field].trim() || null;

    const input = {
      name,
      phone: trimmed('phone'),
      altPhone: trimmed('altPhone'),
      email: trimmed('email'),
      addressLine1: trimmed('addressLine1'),
      addressLine2: trimmed('addressLine2'),
      city: trimmed('city'),
      state: trimmed('state'),
      pincode: trimmed('pincode'),
      gstNumber: trimmed('gstNumber'),
      notes: trimmed('notes'),
    };

    setBusy(true);
    try {
      if (editing) {
        await transportRef.current.updateParty(editing.id, {
          ...input,
          baseFieldHlc: editing.sync.fieldHlc,
        });
        onUpdated?.(name);
      } else {
        const result = await transportRef.current.createParty(input);
        onCreated?.({ id: result.id, name, phone: input.phone, city: input.city });
        setDraft(EMPTY);
        baseline.mark(EMPTY);
      }
      return true;
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : t('party.createFailed'));
      return false;
    } finally {
      setBusy(false);
    }
  }

  // "Save all and update": a party form with something typed in it is saved if it
  // is complete, and named if it is not.
  useUnsavedWork(
    'party-form',
    open && baseline.dirty(draft)
      ? { label: t('updates.saveAll.party', { name: draft.name.trim() || '…' }), save }
      : null,
  );

  /** A plain text cell. The dense grid gives every one of these a column. */
  const text = (field: keyof Draft, label: string, extra: Record<string, unknown> = {}) => (
    <Field label={label}>
      {(id) => (
        <Input
          id={id}
          value={draft[field]}
          onChange={(event) => set(field, event.target.value)}
          {...extra}
        />
      )}
    </Field>
  );

  return (
    <Modal
      open={open}
      onClose={close}
      size="lg"
      title={editing ? t('party.edit.title') : t('party.new.title')}
      footer={
        <>
          <span className="ob-small">{!editing && t('party.saveHint')}</span>
          <span style={{ flex: 1 }} />
          <Button variant="secondary" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" busy={busy} onClick={() => void save()}>
            {busy ? t('party.saving') : editing ? t('party.saveChanges') : t('party.save')}
          </Button>
        </>
      }
    >
      {/* Enter walks the fields and saves on the last one; Ctrl+S saves from
          anywhere in the dialog, which is what registering `record.save` here
          rather than on the screen behind the scrim buys. */}
      <div ref={fields}>
        <FieldGroup title={t('party.group.identity')}>
          <Field label={t('party.field.name')} required span={2}>
            {(id) => (
              <Input
                id={id}
                value={draft.name}
                autoFocus
                onChange={(event) => set('name', event.target.value)}
              />
            )}
          </Field>
        </FieldGroup>

        <FieldGroup title={t('party.group.contact')}>
          {text('phone', t('party.field.phone'), { inputMode: 'tel', className: 'ob-numinput' })}
          {text('altPhone', t('party.field.altPhone'), {
            inputMode: 'tel',
            className: 'ob-numinput',
          })}
          {text('email', t('party.field.email'), { type: 'email' })}
        </FieldGroup>

        <FieldGroup title={t('party.group.address')}>
          <Field label={t('party.field.addressLine1')} span={2}>
            {(id) => (
              <Input
                id={id}
                value={draft.addressLine1}
                onChange={(event) => set('addressLine1', event.target.value)}
              />
            )}
          </Field>
          <Field label={t('party.field.addressLine2')} span={2}>
            {(id) => (
              <Input
                id={id}
                value={draft.addressLine2}
                onChange={(event) => set('addressLine2', event.target.value)}
              />
            )}
          </Field>
          {text('city', t('party.field.city'))}
          {text('state', t('party.field.state'))}
          {text('pincode', t('party.field.pincode'), { className: 'ob-numinput' })}
        </FieldGroup>

        <FieldGroup title={t('party.group.tax')}>
          <Field label={t('party.field.taxId')} hint={t('party.field.taxIdHint')}>
            {(id) => (
              <Input
                id={id}
                value={draft.gstNumber}
                className="ob-mono"
                onChange={(event) => set('gstNumber', event.target.value)}
              />
            )}
          </Field>
          <Field label={t('party.field.notes')} span={3}>
            {(id) => (
              <Textarea
                id={id}
                rows={2}
                value={draft.notes}
                onChange={(event) => set('notes', event.target.value)}
              />
            )}
          </Field>
        </FieldGroup>
      </div>
    </Modal>
  );
}
