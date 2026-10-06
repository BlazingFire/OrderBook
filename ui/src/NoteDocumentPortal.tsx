/**
 * A frozen note (a Printroom job's `NoteDocument`) as sheets, for the screen and
 * for the paper.
 *
 * `noteSheetProps` turns the document into what `OrderNote` draws; the page
 * breaks come from the same `paginateOrderNote` the note screen uses, so the
 * Printroom preview and the paper are the note screen's, sheet for sheet.
 * `NoteDocumentPortal` mounts one copy on `<body>` for the print stylesheet to
 * show; every print goes through `printOnly` (docs/ORDER_NOTES_PLAN.md), so only
 * the portal marked for the job is on the paper.
 */

import { paginateOrderNote, type NoteDocument, type NoteKind } from '@orderbook/shared';
import { useMemo } from 'react';
import { createPortal } from 'react-dom';

import { OrderNote, type OrderNoteProps } from './OrderNote.js';

/** Everything `OrderNote` needs, from a frozen document. */
export function noteSheetProps(document: NoteDocument, kind: NoteKind, printedAt: Date): OrderNoteProps {
  const { model } = document;
  return {
    pages: paginateOrderNote(model, kind),
    kind,
    header: document.header,
    party: document.party,
    partyName: document.partyName,
    vehicleNumber: document.vehicleNumber ?? '',
    notes: document.notes ?? null,
    totalQuantity: model.totalQuantity,
    totalWeightKg: model.totalWeightKg,
    itemCount: model.itemCount,
    namedCount: model.named.length,
    codedCount: model.coded.reduce((sum, group) => sum + group.lines.length, 0),
    printedAt,
  };
}

/** The sheets as a preview on the screen. */
export function NoteDocumentSheets({ document, kind, printedAt }: { document: NoteDocument; kind: NoteKind; printedAt: Date }) {
  const props = useMemo(() => noteSheetProps(document, kind, printedAt), [document, kind, printedAt]);
  return <OrderNote {...props} />;
}

/** The same sheets, mounted on `<body>` where the print stylesheet finds them. */
export function NoteDocumentPortal({
  document: noteDocument,
  kind,
  printedAt,
  portalRef,
}: {
  document: NoteDocument;
  kind: NoteKind;
  printedAt: Date;
  portalRef: { current: HTMLDivElement | null };
}) {
  const props = useMemo(() => noteSheetProps(noteDocument, kind, printedAt), [noteDocument, kind, printedAt]);
  return createPortal(
    <div className="ob-note-print-portal" ref={portalRef}>
      <OrderNote {...props} />
    </div>,
    document.body,
  );
}
