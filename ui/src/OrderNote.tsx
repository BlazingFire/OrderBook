/**
 * The sheets of a Filling note or Dispatch note (docs/ORDER_NOTES_PLAN.md).
 *
 * Presentational only: `paginateOrderNote` has already decided what is on each
 * page, this draws it. Every height a page break depends on is set on the root
 * from `NOTE_LAYOUT` (a named row's own height from `namedRowHeight`), so
 * `order-note.css` cannot drift from the arithmetic.
 */

import {
  isTemporaryId,
  namedLabel,
  namedRowHeight,
  noteBrandCode,
  noteFigure,
  noteRange,
  notePackCode,
  noteStamp,
  NOTE_LAYOUT,
  type NoteHeader,
  type NoteKind,
  type NoteLine,
  type NotePage,
  type NotePartyHeader,
  type NoteSlot,
} from '@orderbook/shared';
import type { CSSProperties } from 'react';

import { t } from './i18n.js';
import './order-note.css';

const LAYOUT_VARS = {
  '--note-page-w': `${NOTE_LAYOUT.pageWidth}px`,
  '--note-page-h': `${NOTE_LAYOUT.pageHeight}px`,
  '--note-head-first-filling': `${NOTE_LAYOUT.headerFirstFilling}px`,
  '--note-head-cont-filling': `${NOTE_LAYOUT.headerContFilling}px`,
  '--note-caption': `${NOTE_LAYOUT.caption}px`,
  '--note-footer-filling': `${NOTE_LAYOUT.footerFilling}px`,
  '--note-signature': `${NOTE_LAYOUT.signature}px`,
  '--note-notes': `${NOTE_LAYOUT.notes}px`,
  '--note-column-label': `${NOTE_LAYOUT.columnLabel}px`,
  '--note-row-coded': `${NOTE_LAYOUT.rowCoded}px`,
  '--note-row-coded-labelled': `${NOTE_LAYOUT.rowCodedLabelled}px`,
  '--note-group-header': `${NOTE_LAYOUT.groupHeader}px`,
} as CSSProperties;

export interface OrderNoteProps {
  pages: NotePage[];
  kind: NoteKind;
  /** Which record this is: its number, whether it is a pending or a final order, and when the lead was made. */
  header: NoteHeader;
  party: NotePartyHeader | null;
  partyName: string;
  vehicleNumber: string;
  /** The record's notes, printed on the last page; blank lines to write on when empty. */
  notes: string | null;
  /** Total pieces and weight of the whole order, for the last page's strip. */
  totalQuantity: number;
  totalWeightKg: number;
  itemCount: number;
  namedCount: number;
  codedCount: number;
  printedAt: Date;
}

const num = noteFigure;

/** The fixed-month stamp the sheets print, shared with the PDF export (`noteStamp`). */
export const stamp = noteStamp;

/** What the sheet calls the record: its number, or its id until it has one. */
function numberOf(header: NoteHeader): string {
  return header.number ?? header.id;
}

const range = noteRange;
const brandCode = noteBrandCode;
const packCode = notePackCode;

function BrandChip({ brand }: { brand: string | null }) {
  if (!brand) return null;
  const code = brandCode(brand);
  return code ? (
    <span className="ob-note-brand" title={brand}>
      {code}
    </span>
  ) : null;
}

/** Always drawn: a code with no packaging shows an empty chip to write in, not nothing. */
function PackagingChip({ value }: { value: string | null }) {
  return value ? (
    <span className="ob-note-chip" title={value}>
      {packCode(value)}
    </span>
  ) : (
    <span className="ob-note-chip ob-note-chip--empty">—</span>
  );
}

function NamedRow({ line, tick }: { line: NoteLine; tick: boolean }) {
  const height = namedRowHeight(line);
  return (
    <div className="ob-note-row" style={{ height }}>
      <span className={`ob-note-grow ob-note-label${height > NOTE_LAYOUT.rowNamed ? ' ob-note-label--tall' : ''}`}>
        {namedLabel(line)}
        <BrandChip brand={line.brand} />
      </span>
      <span className="ob-note-pack ob-note-wrap">{line.packaging}</span>
      <span className="ob-note-colour ob-note-wrap">{line.colour}</span>
      <span className="ob-note-grade">{line.grade}</span>
      <span className="ob-note-qty">{num(line.quantity)}</span>
      {tick && <span className="ob-note-tick" />}
    </div>
  );
}

function CodedSlot({ slot }: { slot: NoteSlot }) {
  if (slot.kind === 'header') {
    return (
      <div className="ob-note-group">
        <span className="ob-note-group-name">{slot.product}</span>
        {slot.continued && <span className="ob-note-group-cont">{t('orderNote.groupContinued')}</span>}
      </div>
    );
  }
  return (
    <div className={`ob-note-coderow${slot.labelled ? ' ob-note-coderow--labelled' : ''}`}>
      {slot.lines.map((line) => (
        <div className="ob-note-cell" key={line.key}>
          {slot.labelled && <div className="ob-note-cell-product">{line.product}</div>}
          <div className="ob-note-cell-code">
            <span className="ob-note-clip">{line.subProduct}</span>
            <BrandChip brand={line.brand} />
          </div>
          <div className="ob-note-cell-detail">
            <PackagingChip value={line.packaging} />
            {line.grade && <span className="ob-note-cell-grade">{line.grade}</span>}
            <span className="ob-note-cell-qty">×{num(line.quantity)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function Strip({
  props,
  page,
  position,
}: {
  props: OrderNoteProps;
  page: NotePage;
  position: 'top' | 'bottom';
}) {
  const { kind, header } = props;
  const last = page.isLast;
  const bottom = position === 'bottom';
  return (
    <div className={`ob-note-strip ob-note-strip-${position}`}>
      <div className="ob-note-strip-cell">
        <div className="ob-note-eyebrow">{last ? t('orderNote.qtyTotal') : t('orderNote.qtyThisPage')}</div>
        <div className={`ob-note-strip-figure${last ? ' ob-note-strip-figure--total' : ''}`}>
          {num(last ? props.totalQuantity : page.quantity)}
          <span className="ob-note-strip-unit"> {t('orderNote.unit')}</span>
        </div>
        {bottom && (
          <div className="ob-note-strip-note">
            {last
              ? t('orderNote.itemsPages', { items: props.itemCount, pages: page.pageCount })
              : t('orderNote.carriedForward', { n: num(page.runQuantity) })}
          </div>
        )}
      </div>
      <span className="ob-note-strip-rule" />
      <div className="ob-note-strip-cell">
        <div className="ob-note-eyebrow">{last ? t('orderNote.weightTotal') : t('orderNote.weightThisPage')}</div>
        <div className={`ob-note-strip-figure${last ? ' ob-note-strip-figure--total' : ''}`}>
          {num(last ? props.totalWeightKg : page.weightKg)}
          <span className="ob-note-strip-unit"> kg</span>
        </div>
        {bottom && (
          <div className="ob-note-strip-note">
            {last ? t('orderNote.grossOfPacking') : t('orderNote.carriedForward', { n: num(page.runWeightKg) })}
          </div>
        )}
      </div>
      <span className="ob-note-strip-rule" />
      <div className="ob-note-strip-cell">
        <div className="ob-note-eyebrow">{t('orderNote.dispatchVehicle')}</div>
        <div className="ob-note-vehicle ob-note-clip">{kind === 'dispatch' ? props.vehicleNumber : ''}</div>
      </div>
      <span className="ob-note-strip-rule" />
      <div className="ob-note-strip-page">
        <div className="ob-note-strip-page-id ob-note-clip">{numberOf(header)}</div>
        <div className="ob-note-strip-page-no">
          {t('orderNote.page', { n: page.pageNo, total: page.pageCount })}
        </div>
        <div className="ob-note-strip-note">
          {last ? t('orderNote.endOfList', { n: props.itemCount }) : t('orderNote.carryOn')}
        </div>
      </div>
    </div>
  );
}

function Header({ props, page }: { props: OrderNoteProps; page: NotePage }) {
  const { kind, header, party, partyName } = props;
  const filling = kind === 'filling';
  const title = filling ? t('orderNote.filling') : t('orderNote.dispatch');
  const printed = stamp(props.printedAt);

  if (!page.isFirst) {
    return (
      <div className="ob-note-head-cont">
        <div className="ob-note-clip">
          <span className="ob-note-head-cont-title">{filling ? partyName : title}</span>
          <span className="ob-note-head-cont-suffix">
            {filling ? ` — ${title} · ${t('orderNote.continued')}` : ` · ${t('orderNote.continued')}`}
          </span>
        </div>
      </div>
    );
  }

  if (!filling) {
    return (
      <div className="ob-note-head-slim">
        <h2 className="ob-note-clip">{title}</h2>
        <div className="ob-note-printed ob-note-mono">
          {t('orderNote.printed')} {printed}
        </div>
      </div>
    );
  }

  const meta = [party?.city, party?.phone, party?.gstNumber ? `GSTIN ${party.gstNumber}` : null]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="ob-note-head-full">
      <div style={{ minWidth: 0 }}>
        <div className="ob-note-party ob-note-clip">{partyName}</div>
        {meta && <div className="ob-note-party-meta ob-note-clip">{meta}</div>}
        {party?.partyCode && (
          <span className="ob-note-dealer">
            <span className="ob-note-eyebrow">{t('orderNote.dealer')}</span>
            <span className="ob-note-dealer-code">{party.partyCode}</span>
          </span>
        )}
      </div>
      <div className="ob-note-meta">
        <span className="ob-note-eyebrow">
          {t(header.source === 'lead' ? 'orderNote.pendingOrderNo' : 'orderNote.orderId')}
        </span>
        <span className="ob-note-meta-value ob-note-meta-id">
          {numberOf(header)}
          {isTemporaryId(header.id) && <span className="ob-note-unsynced">{t('orderNote.unsynced')}</span>}
        </span>
        <span className="ob-note-eyebrow">{t('orderNote.leadGenerated')}</span>
        <span className="ob-note-meta-value ob-note-meta-when">{stamp(header.createdAt)}</span>
        <span className="ob-note-eyebrow">{t('orderNote.printed')}</span>
        <span className="ob-note-meta-value ob-note-meta-when">{printed}</span>
      </div>
    </div>
  );
}

function Sheet({ props, page }: { props: OrderNoteProps; page: NotePage }) {
  const filling = props.kind === 'filling';
  const hasLeft = page.leftCount > 0;
  const hasRight = page.rightCount > 0;
  /** A page of a long note's own: the notes sit under the strip, the signature row stays at the foot. */
  const notesOnly = !hasLeft && !hasRight && page.notesHeight > 0;
  // The part of the notes this page carries (`paginateOrderNote` made room for all of them).
  const notes = page.notesText.trim();
  const signatures = filling
    ? [t('orderNote.signFilledBy'), t('orderNote.signCheckedBy'), t('orderNote.signStoreInCharge')]
    : [t('orderNote.signSupervisor'), t('orderNote.signLoadedBy'), t('orderNote.signCheckedBy')];

  return (
    <section className={`ob-note-page ob-note-${props.kind}`}>
      <Header props={props} page={page} />
      {!filling && <Strip props={props} page={page} position="top" />}
      <div className="ob-note-body" style={notesOnly ? { flex: 'none' } : undefined}>
        {hasLeft && (
          <div
            className={`ob-note-half ob-note-half--left${hasRight ? '' : ' ob-note-half--only'}`}
            style={{ flex: `1 1 ${page.wideLeft ? '100%' : '58%'}` }}
          >
            <div className="ob-note-caption">
              <span>{t('orderNote.productLines')}</span>
              <span>{range(page.leftFrom, page.leftCount, props.namedCount)}</span>
            </div>
            <div className="ob-note-columns ob-note-columns--named">
              {page.left.map((column, index) => (
                <div className="ob-note-column" key={index}>
                  <div className="ob-note-colhead">
                    <span className="ob-note-grow">{t('orderNote.subProductBrand')}</span>
                    <span className="ob-note-pack">{t('orderNote.packing')}</span>
                    <span className="ob-note-colour">{t('orderNote.colour')}</span>
                    <span className="ob-note-grade">{t('orderNote.grade')}</span>
                    <span className="ob-note-qty">{t('orderNote.qty')}</span>
                    {filling && <span className="ob-note-tick ob-note-tick--head" />}
                  </div>
                  {column.map((line) => (
                    <NamedRow key={line.key} line={line} tick={filling} />
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}
        {hasLeft && hasRight && <span className="ob-note-divider" />}
        {hasRight && (
          <div
            className={`ob-note-half ob-note-half--right${hasLeft ? '' : ' ob-note-half--only'}`}
            style={{
              flex: `1 1 ${page.wideRight ? '100%' : '42%'}`,
              '--note-codes-per-row': page.wideRight ? NOTE_LAYOUT.codesPerRowWide : NOTE_LAYOUT.codesPerRow,
            } as CSSProperties}
          >
            <div className="ob-note-caption">
              <span>{t('orderNote.codedProducts')}</span>
              <span>{range(page.rightFrom, page.rightCount, props.codedCount)}</span>
            </div>
            <div className="ob-note-columns ob-note-columns--coded">
              {page.right.map((column, index) => (
                <div className="ob-note-column" key={index}>
                  {column.map((slot, slotIndex) => (
                    <CodedSlot key={slotIndex} slot={slot} />
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      {page.notesHeight > 0 && (
        <div className={`ob-note-notes${notesOnly ? ' ob-note-notes--top' : ''}`} style={{ height: page.notesHeight }}>
          <div className="ob-note-eyebrow">{t('orderNote.notes')}</div>
          {notes ? (
            <div className="ob-note-notes-text">{notes}</div>
          ) : (
            <div className="ob-note-notes-blank">
              <div />
              <div />
            </div>
          )}
        </div>
      )}
      {page.isLast && (
        <div className="ob-note-sign">
          {signatures.map((label) => (
            <div className="ob-note-sign-slot" key={label}>
              <div className="ob-note-sign-line" />
              <div className="ob-note-eyebrow">{label}</div>
            </div>
          ))}
        </div>
      )}
      {filling && <Strip props={props} page={page} position="bottom" />}
    </section>
  );
}

export function OrderNote(props: OrderNoteProps) {
  return (
    <div className="ob-note-scope" style={LAYOUT_VARS}>
      {props.pages.map((page) => (
        <Sheet key={page.pageNo} props={props} page={page} />
      ))}
    </div>
  );
}
