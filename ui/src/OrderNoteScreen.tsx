/**
 * The preview of an order's Filling note or Dispatch note, and the way to print
 * it (docs/ORDER_NOTES_PLAN.md).
 *
 * A sub-screen with a back button, like every record opened from a list. The
 * panel that hosts it supplies the order and party it already holds — the
 * Office's from its local snapshot, so a note prints with the Master
 * unreachable — and the one write, the vehicle number.
 *
 * Printing goes to the desktop shell when it offers it (`printPage`), otherwise
 * to the browser's own `window.print()`. The printer is remembered per PC, in
 * this browser profile, not per company: a printer belongs to the machine.
 */

import {
  buildOrderNote,
  cleanVehicleNumber,
  clampNoteCopies,
  isTemporaryId,
  noteHeader,
  NOTE_MAX_COPIES,
  paginateOrderNote,
  type DesktopBridge,
  type Lead,
  type NoteKind,
  type NoteSource,
  type Order,
  type Party,
} from '@orderbook/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Button } from './Button.js';
import { EditorScreen } from './EditorScreen.js';
import { t } from './i18n.js';
import { Modal } from './Modal.js';
import { useUnsavedWork } from './unsavedWork.js';
import { OrderNote } from './OrderNote.js';
import { printOnly } from './printPortal.js';
import type { PrintroomTransport } from './printroomModel.js';
import { SendToPrintroomDialog } from './SendToPrintroomDialog.js';
import { Segmented } from './Tabs.js';
import { useToast } from './Toast.js';

const KEY_PRINTER = 'ob.note.printer';

function stored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function remember(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage blocked: the choice simply is not remembered.
  }
}

export interface OrderNoteScreenProps {
  /** The pending order (a lead) or the final order the note is made from. */
  record: Order | Lead;
  source: NoteSource;
  party: Party | null;
  initialKind: NoteKind;
  /**
   * Whether the person may change the vehicle number: `orders.edit`, on an
   * order not yet dispatched. A pending order's is always editable, because it
   * is only printed — see `onSaveVehicle`.
   */
  canEditVehicle: boolean;
  /**
   * Saves the vehicle number; null clears it. May reject — the field then says
   * so. Never called for a pending order: a lead has no vehicle column, so its
   * number is typed for the sheet and gone when the screen closes.
   */
  onSaveVehicle: (vehicleNumber: string | null) => Promise<unknown>;
  onBack: () => void;
  desktop?: Pick<DesktopBridge, 'listPrinters' | 'printPage' | 'savePdf'>;
  /**
   * Offers "Send to Printroom". Supplied by the panel only to somebody holding
   * `print.send`, and for a pending order only once the Master has it (the
   * Master builds the sheet from its own copy).
   */
  printroom?: PrintroomTransport;
}

export function OrderNoteScreen({
  record,
  source,
  party,
  initialKind,
  canEditVehicle,
  onSaveVehicle,
  onBack,
  desktop,
  printroom,
}: OrderNoteScreenProps) {
  const toast = useToast();
  const [sending, setSending] = useState(false);
  // A record still carrying the id its panel made offline is not on the Master yet: it has nothing to print from.
  const canSend = printroom !== undefined && !isTemporaryId(record.id);
  const printOnlyVehicle = source === 'lead';
  const editableVehicle = printOnlyVehicle || canEditVehicle;
  const savedVehicle = source === 'order' ? ((record as Order).vehicleNumber ?? '') : '';
  const [kind, setKind] = useState<NoteKind>(initialKind);
  const [vehicle, setVehicle] = useState(savedVehicle);
  /** The vehicle number as last sent, so a blur with nothing changed writes nothing. */
  const sentVehicle = useRef(savedVehicle);
  const [copiesText, setCopiesText] = useState('1');
  const copies = clampNoteCopies(copiesText.trim() === '' ? Number.NaN : Number(copiesText));
  const portalRef = useRef<HTMLDivElement | null>(null);
  const [saving, setSaving] = useState(false);
  const [vehicleError, setVehicleError] = useState<string | null>(null);
  const [printers, setPrinters] = useState<{ name: string; displayName: string }[]>([]);
  const [printer, setPrinter] = useState(() => stored(KEY_PRINTER) ?? '');
  const [printing, setPrinting] = useState(false);
  /** The Preview dialog (1.4 R11): the pages as printed, with Print and Save PDF at hand. */
  const [previewing, setPreviewing] = useState(false);
  /** One print or Save PDF at a time: `printOnly` marks the page and is not re-entrant. */
  const busyRef = useRef(false);
  const [printedAt] = useState(() => new Date());

  const model = useMemo(() => buildOrderNote(record), [record]);
  const header = useMemo(() => noteHeader(record, source), [record, source]);
  const pages = useMemo(() => paginateOrderNote(model, kind), [model, kind]);

  useEffect(() => {
    let alive = true;
    desktop?.listPrinters?.().then(
      (list) => {
        if (alive) setPrinters(list);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [desktop]);

  // A remembered printer that has gone falls back to asking, rather than
  // sending a job to a name Windows no longer has.
  const chosenPrinter = printers.some((entry) => entry.name === printer) ? printer : '';

  const noteProps = {
    pages,
    kind,
    header,
    party,
    partyName: record.partyName,
    vehicleNumber: vehicle,
    notes: record.notes,
    totalQuantity: model.totalQuantity,
    totalWeightKg: model.totalWeightKg,
    itemCount: model.itemCount,
    namedCount: model.named.length,
    codedCount: model.coded.reduce((sum, group) => sum + group.lines.length, 0),
    printedAt,
  };

  async function print(): Promise<void> {
    if (busyRef.current) return;
    busyRef.current = true;
    if (!desktop?.printPage) {
      // A browser prints one copy at a time: say where the rest is asked for.
      try {
        if (copies > 1) toast.push(t('orderNote.copiesHint', { n: copies }), { tone: 'info' });
        await printOnly(portalRef.current, () => window.print());
      } finally {
        busyRef.current = false;
      }
      return;
    }
    const printPage = desktop.printPage;
    setPrinting(true);
    try {
      const result = await printOnly(portalRef.current, () =>
        printPage({ deviceName: chosenPrinter || undefined, copies }),
      );
      if (!result.ok) {
        toast.push(t('orderNote.printFailed', { error: result.error ?? '—' }), { tone: 'error' });
      }
    } catch (caught) {
      toast.push(
        t('orderNote.printFailed', { error: caught instanceof Error ? caught.message : '—' }),
        { tone: 'error' },
      );
    } finally {
      busyRef.current = false;
      setPrinting(false);
    }
  }

  async function savePdf(): Promise<void> {
    const save = desktop?.savePdf;
    if (!save || busyRef.current) return;
    busyRef.current = true;
    setSaving(true);
    try {
      const result = await printOnly(portalRef.current, () =>
        save({ fileName: `${header.number ?? header.id}-${kind}.pdf` }),
      );
      // A closed Save dialog is a cancel, not a failure worth a toast.
      if (!result.ok && !result.cancelled) {
        toast.push(t('orderNote.savePdfFailed', { error: result.error ?? '—' }), { tone: 'error' });
      }
    } catch (caught) {
      toast.push(
        t('orderNote.savePdfFailed', { error: caught instanceof Error ? caught.message : '—' }),
        { tone: 'error' },
      );
    } finally {
      busyRef.current = false;
      setSaving(false);
    }
  }

  const printRef = useRef(print);
  printRef.current = print;
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p') {
        event.preventDefault();
        // Key auto-repeat must not queue silent jobs of N copies.
        if (!event.repeat) void printRef.current();
      } else if (event.altKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        setKind('filling');
      } else if (event.altKey && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        setKind('dispatch');
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function changePrinter(next: string): void {
    setPrinter(next);
    remember(KEY_PRINTER, next);
  }

  // "Save all and update": a vehicle number typed on an order and not yet saved (it
  // saves when the field loses focus) is saved. On a pending order it is only
  // printed, never saved, so there is nothing to lose.
  useUnsavedWork(
    `vehicle:${record.id}`,
    !printOnlyVehicle && editableVehicle && cleanVehicleNumber(vehicle).trim() !== sentVehicle.current
      ? {
          label: t('updates.saveAll.vehicle', { number: cleanVehicleNumber(vehicle).trim() || '…' }),
          save: async () => {
            const value = cleanVehicleNumber(vehicle).trim();
            try {
              await onSaveVehicle(value === '' ? null : value);
              sentVehicle.current = value;
              // Shown as saved (and re-rendered, so this form stops counting as unsaved).
              setVehicle(value);
              return true;
            } catch {
              return false;
            }
          },
        }
      : null,
  );

  function saveVehicle(): void {
    const value = cleanVehicleNumber(vehicle).trim();
    setVehicle(value);
    if (printOnlyVehicle || value === sentVehicle.current) return;
    const before = sentVehicle.current;
    sentVehicle.current = value;
    setVehicleError(null);
    onSaveVehicle(value === '' ? null : value).catch((caught: unknown) => {
      // Not saved: the next blur tries again.
      if (sentVehicle.current === value) sentVehicle.current = before;
      setVehicleError(caught instanceof Error ? caught.message : t('validation.order.vehicleInvalid'));
    });
  }

  return (
    <EditorScreen
      meta={<span className="ob-small">{t('orderNote.preview')}</span>}
      onBack={() => {
        onBack();
        return true;
      }}
      backLabel={t('action.backToList')}
      actions={
        <>
          <Segmented
            value={kind}
            onChange={setKind}
            options={[
              { value: 'filling', label: t('orderNote.filling') },
              { value: 'dispatch', label: t('orderNote.dispatch') },
            ]}
          />
          <Button variant="secondary" onClick={() => setPreviewing(true)}>
            {t('orderNote.previewButton')}
          </Button>
          {canSend && (
            <Button variant="secondary" disabled={printing || saving} onClick={() => setSending(true)}>
              {t('orderNote.sendToPrintroom')}
            </Button>
          )}
          {desktop?.savePdf && (
            <Button variant="secondary" busy={saving} disabled={printing || saving} onClick={() => void savePdf()}>
              {t('orderNote.savePdf')}
            </Button>
          )}
          <Button variant="primary" busy={printing} disabled={printing || saving} onClick={() => void print()}>
            {t('orderNote.print')}
          </Button>
        </>
      }
    >
      <div className="ob-note-toolbar">
        {kind === 'dispatch' && (
          <label className="ob-note-toolbar-item">
            <span className="ob-small">{t('orderNote.vehicleNo')}</span>
            <input
              className="ob-input ob-note-vehicle-input"
              value={vehicle}
              maxLength={20}
              placeholder={t('orderNote.vehiclePlaceholder')}
              disabled={!editableVehicle}
              title={
                !editableVehicle
                  ? t('orderNote.vehicleLocked')
                  : printOnlyVehicle
                    ? t('orderNote.vehicleNotSaved')
                    : undefined
              }
              onChange={(event) => setVehicle(cleanVehicleNumber(event.target.value))}
              onBlur={saveVehicle}
              onKeyDown={(event) => {
                if (event.key === 'Enter') saveVehicle();
              }}
              aria-invalid={vehicleError !== null}
            />
            {vehicleError && (
              <span className="ob-small" role="alert" style={{ color: 'var(--state-conflict)' }}>
                {vehicleError}
              </span>
            )}
          </label>
        )}

        <label className="ob-note-toolbar-item">
          <span className="ob-small">{t('orderNote.copies')}</span>
          <input
            className="ob-input ob-note-copies-input"
            type="number"
            min={1}
            max={NOTE_MAX_COPIES}
            step={1}
            value={copiesText}
            onChange={(event) => setCopiesText(event.target.value)}
            onBlur={() => setCopiesText(String(copies))}
          />
        </label>

        {desktop?.listPrinters && (
          <label className="ob-note-toolbar-item">
            <span className="ob-small">{t('orderNote.printer')}</span>
            <select
              className="ob-input"
              value={chosenPrinter}
              onChange={(event) => changePrinter(event.target.value)}
            >
              <option value="">{t('orderNote.printerDialog')}</option>
              {printers.map((entry) => (
                <option key={entry.name} value={entry.name}>
                  {entry.displayName || entry.name}
                </option>
              ))}
            </select>
          </label>
        )}

      </div>

      <div className="ob-note-canvas">
        <OrderNote {...noteProps} />
      </div>

      <Modal
        open={previewing}
        onClose={() => setPreviewing(false)}
        size="xl"
        title={t('orderNote.preview.title', {
          title: `${header.number ?? header.id} · ${t(kind === 'filling' ? 'orderNote.filling' : 'orderNote.dispatch')}`,
        })}
        footer={
          <>
            {desktop?.savePdf && (
              <Button variant="secondary" busy={saving} disabled={printing || saving} onClick={() => void savePdf()}>
                {t('orderNote.savePdf')}
              </Button>
            )}
            <Button variant="primary" busy={printing} disabled={printing || saving} onClick={() => void print()}>
              {t('orderNote.print')}
            </Button>
          </>
        }
      >
        <div className="ob-note-canvas">
          <OrderNote {...noteProps} />
        </div>
      </Modal>

      {createPortal(
        <div className="ob-note-print-portal" ref={portalRef}>
          <OrderNote {...noteProps} />
        </div>,
        document.body,
      )}

      {canSend && printroom && (
        <SendToPrintroomDialog
          open={sending}
          onClose={() => setSending(false)}
          transport={printroom}
          source={source}
          sourceId={record.id}
          label={`${header.number ?? header.id} · ${record.partyName}`}
          initialKind={kind}
          initialVehicle={vehicle}
          initialCopies={copies}
        />
      )}
    </EditorScreen>
  );
}
