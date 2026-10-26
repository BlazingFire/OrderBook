/**
 * "Send to Printroom": the small dialog that queues a pending or a final
 * order's note for the PC with the printer (docs/ORDER_NOTES_PLAN.md).
 *
 * The sender picks which note, how many copies, which printroom ("Any" or one
 * that is online), a vehicle number for a Dispatch note and an optional message.
 * The Master builds the sheet itself from the record, so nothing here is the
 * note; one request id is kept for as long as the dialog stays open, so pressing
 * Send again after a slow answer cannot queue the sheet twice.
 *
 * Sending needs the Master: with it out of reach the dialog says so and the
 * note's own Print button still works.
 */

import {
  cleanVehicleNumber,
  MAX_PRINT_COPIES,
  PRINT_LIMITS,
  type NoteKind,
  type NoteSource,
  type PrintJob,
  type PrintStation,
} from '@orderbook/shared';
import { useEffect, useRef, useState } from 'react';

import { Button } from './Button.js';
import { apiErrorText } from './errorText.js';
import { FieldError, FormField, Input } from './Form.js';
import { t } from './i18n.js';
import { Modal } from './Modal.js';
import { newRequestId, type PrintroomTransport } from './printroomModel.js';
import { Segmented } from './Tabs.js';
import { useToast } from './Toast.js';

export interface SendToPrintroomDialogProps {
  open: boolean;
  onClose: () => void;
  transport: PrintroomTransport;
  source: NoteSource;
  sourceId: string;
  /** The record as the sender knows it: its number and party. */
  label: string;
  initialKind: NoteKind;
  initialVehicle?: string;
  initialCopies?: number;
  /** The sender's Bold tick from the note screen: the frozen sheet prints exactly this. */
  bold?: boolean;
  onSent?: (job: PrintJob) => void;
}

export function SendToPrintroomDialog({
  open,
  onClose,
  transport,
  source,
  sourceId,
  label,
  initialKind,
  initialVehicle = '',
  initialCopies = 1,
  bold,
  onSent,
}: SendToPrintroomDialogProps) {
  const toast = useToast();
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const requestId = useRef(newRequestId());
  const [kind, setKind] = useState<NoteKind>(initialKind);
  const [copiesText, setCopiesText] = useState(String(initialCopies));
  const [targetId, setTargetId] = useState('');
  const [vehicle, setVehicle] = useState(initialVehicle);
  const [message, setMessage] = useState('');
  const [stations, setStations] = useState<PrintStation[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A fresh dialog is a fresh send: new request id, the caller's starting values, the printrooms read again.
  useEffect(() => {
    if (!open) return;
    requestId.current = newRequestId();
    setKind(initialKind);
    setCopiesText(String(initialCopies));
    setTargetId('');
    setVehicle(initialVehicle);
    setMessage('');
    setError(null);
    let cancelled = false;
    void transportRef.current.listStations().then(
      (found) => {
        if (!cancelled) setStations(found);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
    // The starting values are read when the dialog opens, not followed afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const copies = Number(copiesText);
  const copiesValid = Number.isInteger(copies) && copies >= 1 && copies <= MAX_PRINT_COPIES;

  async function send(): Promise<void> {
    if (!copiesValid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const job = await transportRef.current.sendJob({
        requestId: requestId.current,
        kind,
        source,
        sourceId,
        copies,
        targetStationId: targetId === '' ? null : targetId,
        vehicleNumber: kind === 'dispatch' && vehicle.trim() !== '' ? vehicle : null,
        note: message.trim() === '' ? null : message.trim(),
        bold: bold ?? null,
      });
      toast.push(t('printroom.dialog.sent'), { tone: 'ok' });
      onSent?.(job);
      onClose();
    } catch (caught) {
      const unavailable = (caught as { code?: unknown } | null)?.code === 'unavailable';
      setError(unavailable ? t('printroom.dialog.offline') : apiErrorText(caught, 'printroom.error.load'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title={t('printroom.dialog.title')}
      subtitle={label}
      footer={
        <>
          <span style={{ flex: 1 }} />
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" busy={busy} disabled={!copiesValid} onClick={() => void send()}>
            {t('printroom.dialog.send')}
          </Button>
        </>
      }
    >
      <div className="ob-print-dialog">
        <FormField label={t('printroom.dialog.kind')}>
          {() => (
            <Segmented
              value={kind}
              onChange={setKind}
              options={[
                { value: 'filling', label: t('orderNote.filling') },
                { value: 'dispatch', label: t('orderNote.dispatch') },
              ]}
            />
          )}
        </FormField>

        <FormField
          label={t('printroom.column.copies')}
          error={copiesValid ? undefined : t('validation.print.copies')}
        >
          {(id) => (
            <Input
              id={id}
              type="number"
              min={1}
              max={MAX_PRINT_COPIES}
              step={1}
              value={copiesText}
              invalid={!copiesValid}
              onChange={(event) => setCopiesText(event.target.value)}
            />
          )}
        </FormField>

        <FormField label={t('printroom.dialog.target')}>
          {(id) => (
            <select id={id} className="ob-input" value={targetId} onChange={(event) => setTargetId(event.target.value)}>
              <option value="">{t('printroom.station.anyStation')}</option>
              {stations.map((station) => (
                <option key={station.id} value={station.id} disabled={!station.online}>
                  {station.online ? station.name : `${station.name} (${t('printroom.station.offline')})`}
                </option>
              ))}
            </select>
          )}
        </FormField>

        {kind === 'dispatch' && (
          <FormField label={t('orderNote.vehicleNo')}>
            {(id) => (
              <Input
                id={id}
                value={vehicle}
                maxLength={20}
                placeholder={t('orderNote.vehiclePlaceholder')}
                onChange={(event) => setVehicle(cleanVehicleNumber(event.target.value))}
              />
            )}
          </FormField>
        )}

        <FormField label={t('printroom.dialog.note')}>
          {(id) => (
            <Input
              id={id}
              value={message}
              maxLength={PRINT_LIMITS.noteMax}
              onChange={(event) => setMessage(event.target.value)}
            />
          )}
        </FormField>

        {error && <FieldError>{error}</FieldError>}
      </div>
    </Modal>
  );
}
