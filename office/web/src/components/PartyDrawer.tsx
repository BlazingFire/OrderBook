/**
 * PartyDrawer — create a new party without leaving whatever screen needed one
 * (docs/LEAD_GENERATION_FLOW.md §3.1's "a customer standing at the counter is
 * often new"). Visually matches `New-Party.dc.html`; behaviourally it is the
 * inline "+ New party" flow that used to live in AddLeadScreen, pulled out so
 * a second screen can reuse it.
 *
 * Props are deliberately generic, not Add-Lead-specific, because Catalog/
 * Parties reuses this exact component in a follow-up pass:
 *
 *   open      — whether the drawer is open.
 *   party     — pass an existing party to edit it (title becomes "Edit
 *               party", Save calls `api.updateParty`); omit to create a new
 *               one. Added alongside the Catalog/Parties view-detail drawer,
 *               which needed somewhere for its "Edit party" action to go —
 *               same shape as `ProductDrawer`'s edit mode.
 *   onClose   — called to dismiss without creating (Cancel, Esc, backdrop,
 *               the drawer's own close button). The draft is discarded.
 *   onCreated — called once `api.createParty` resolves (create mode only).
 *               The party write is queued like every other write in this app
 *               (docs §"offline is the normal path"), so the server only
 *               hands back a `QueuedResult` — an id, nothing else.
 *               `onCreated` is given that id plus the fields the caller just
 *               typed, which is enough for a screen to select the new party
 *               immediately without waiting for it to sync back through the
 *               snapshot.
 *   onUpdated — called once `api.updateParty` resolves (edit mode only),
 *               with the caller-typed name for the confirmation toast — same
 *               asymmetry as `ProductDrawer.onUpdated`.
 *   onError   — surfaces a failure through the caller's own error channel,
 *               same convention as every other screen in this panel.
 *
 * Party-specific product rate overrides (`PartyProductVariant`) are shown in
 * `New-Party.dc.html` too, but they need the product catalogue alongside the
 * party fields — that belongs to the Catalog/Parties view-detail drawer that
 * reads them, not this create/edit form.
 */

import { useEffect, useState } from 'react';
import type { Party } from '@orderbook/shared';

import { api } from '../api';
import { t } from '../i18n/strings';
import { Button } from '../ui/Button';
import { Drawer } from '../ui/Drawer';
import { FormField, Input, Textarea } from '../ui/Form';

export interface CreatedParty {
  id: string;
  name: string;
  phone: string | null;
  city: string | null;
}

interface PartyDrawerProps {
  open: boolean;
  party?: Party | null;
  onClose: () => void;
  onCreated?: (party: CreatedParty) => void;
  onUpdated?: (name: string) => void;
  onError: (message: string) => void;
}

export function PartyDrawer({ open, party, onClose, onCreated, onUpdated, onError }: PartyDrawerProps) {
  const editing = party ?? null;

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [city, setCity] = useState('');
  const [gstNumber, setGstNumber] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  function fillFrom(source: Party): void {
    setName(source.name);
    setPhone(source.phone ?? '');
    setCity(source.city ?? '');
    setGstNumber(source.gstNumber ?? '');
    setNotes(source.notes ?? '');
  }

  function reset(): void {
    setName('');
    setPhone('');
    setCity('');
    setGstNumber('');
    setNotes('');
  }

  useEffect(() => {
    if (open && editing) fillFrom(editing);
    else if (open) reset();
  }, [open, editing?.id]);

  function close(): void {
    reset();
    onClose();
  }

  async function save(): Promise<void> {
    const trimmedName = name.trim();
    if (!trimmedName) {
      onError(t('party.nameRequired'));
      return;
    }

    const trimmedPhone = phone.trim() || null;
    const trimmedCity = city.trim() || null;
    const input = {
      name: trimmedName,
      phone: trimmedPhone,
      city: trimmedCity,
      gstNumber: gstNumber.trim() || null,
      notes: notes.trim() || null,
    };

    setBusy(true);
    try {
      if (editing) {
        await api.updateParty(editing.id, input);
        onUpdated?.(trimmedName);
      } else {
        const result = await api.createParty(input);
        onCreated?.({ id: result.id, name: trimmedName, phone: trimmedPhone, city: trimmedCity });
        reset();
      }
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : t('party.createFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer open={open} onClose={close} title={editing ? t('party.edit.title') : t('party.new.title')}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-12)' }}>
        <FormField label={t('party.field.name')} required>
          {(id) => (
            <Input
              id={id}
              value={name}
              autoFocus
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void save();
              }}
            />
          )}
        </FormField>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--s-12)' }}>
          <FormField label={t('party.field.phone')}>
            {(id) => (
              <Input
                id={id}
                value={phone}
                inputMode="tel"
                className="ob-numinput"
                onChange={(event) => setPhone(event.target.value)}
              />
            )}
          </FormField>
          <FormField label={t('party.field.city')}>
            {(id) => <Input id={id} value={city} onChange={(event) => setCity(event.target.value)} />}
          </FormField>
        </div>

        <FormField label={t('party.field.taxId')} hint={t('party.field.taxIdHint')}>
          {(id) => (
            <Input
              id={id}
              value={gstNumber}
              className="ob-mono"
              onChange={(event) => setGstNumber(event.target.value)}
            />
          )}
        </FormField>

        <FormField label={t('party.field.notes')}>
          {(id) => (
            <Textarea id={id} rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} />
          )}
        </FormField>

        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-8)', marginTop: 'var(--s-4)' }}>
          <Button variant="primary" busy={busy} onClick={() => void save()}>
            {busy ? t('party.saving') : editing ? t('party.saveChanges') : t('party.save')}
          </Button>
          {!editing && <span className="ob-small">{t('party.saveHint')}</span>}
        </div>
      </div>
    </Drawer>
  );
}
