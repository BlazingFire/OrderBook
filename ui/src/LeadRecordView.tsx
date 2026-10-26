/**
 * One new order (lead) in full, on both panels: a strip of its facts, its lines
 * as a table, and an aside with the next step (convert) over its notes and
 * history (owner mockup, 2026-10-08).
 *
 * The Master hands it the record and its HTTP transport; the Office hands it
 * the snapshot's record and its outbox-backed client. The stage moves from the
 * header (`LeadStageMenu`), not from here.
 *
 *  - Add note and the Convert card are **absent**, not disabled, without the
 *    matching permission;
 *  - `onEdit` is present only while the order can be edited: it is where
 *    "Add weights", "Add product" and the follow-up pencil go.
 *
 * Rendered as the body of an `EditorScreen` — the party name, number and way
 * back live in its header, not here.
 */

import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { shownColour } from '@orderbook/shared';
import type { MessageKey } from '@orderbook/shared';
import type { Lead, LineItem, OptionListItem, Party, PipelineStage } from '@orderbook/shared';

import { Avatar } from './Avatar.js';
import { CopyButton } from './ActionButtons.js';
import { Button, IconButton } from './Button.js';
import { ColourChip, StatusPill, stageTone, useColourHex, useColourLabel } from './DataDisplay.js';
import { DateField, FormField, Input } from './Form.js';
import { formatDateTime, formatKg } from './format.js';
import { apiErrorText } from './errorText.js';
import { t } from './i18n.js';
import { Icon, type IconName } from './icons.js';
import { Popover } from './Popover.js';
import { useUnsavedWork } from './unsavedWork.js';
import { RecordNumber, recordNumberText } from './RecordNumber.js';
import { ConflictBanner } from './States.js';

/** What this view may reach. Held in a ref: callers build the object inline. */
export interface LeadRecordTransport {
  addLeadRemark: (id: string, message: string) => Promise<unknown>;
  setLeadStage: (id: string, stageId: string) => Promise<unknown>;
  convertLead: (
    id: string,
    input: { dispatchAddressLabel: string | null; expectedDispatchDate: string | null },
  ) => Promise<unknown>;
}

export interface LeadRecordViewProps {
  lead: Lead;
  optionLists: OptionListItem[];
  /** `leads.packagingRequiredOnConvert`, already resolved by the caller. */
  packagingRequired: boolean;
  /** The party's own record, or null when the caller may not read it. */
  party: Party | null;
  /** `leads.edit`: Add note. */
  canEdit: boolean;
  /** `lead.convert`: the Convert card. */
  canConvert: boolean;
  transport: LeadRecordTransport;
  /** Opens Edit order; absent when the order cannot be edited. */
  onEdit?: () => void;
  /** Handed what `convertLead` resolved to: the Master's new order, the Office's queued result. */
  onConverted: (result: unknown) => void;
  /** Opens the final order it became; absent where this panel has no such screen. */
  onOpenOrder?: (orderId: string) => void;
  onError: (message: string) => void;
}

/** `yyyy-mm-dd` of a local day, `offset` days from today. */
function localIsoDate(offset = 0): string {
  const day = new Date();
  day.setDate(day.getDate() + offset);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

/** `2026-10-11` → `11-10-2026`, the way the rest of the screen writes a day. */
function dayText(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}-${m}-${y}`;
}

/** "in 3 days", "tomorrow", "2 days ago" — whole local days from today. */
function dayDistance(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const today = new Date();
  const from = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const days = Math.round((Date.UTC(y!, m! - 1, d!) - from) / 86_400_000);
  return new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(days, 'day');
}

/** The order's number with a Copy button, for the header. */
export function CopyRecordNumber({ record }: { record: { id: string; poNumber?: string | null } }) {
  return (
    <span className="ob-leadrec-number">
      <RecordNumber record={record} small />
      <CopyButton value={recordNumberText(record)} label={t('lead.detail.copyNumber')} iconOnly />
    </span>
  );
}

export interface RecordMenuItem {
  label: string;
  onSelect?: () => void;
  /** A link instead of an action — the PDF, which opens beside the app. */
  href?: string;
  danger?: boolean;
}

/** A header button that opens a short menu: Print & PDF, or the icon-only ⋯. */
export function RecordMenu({
  label,
  icon,
  items,
  iconOnly = false,
}: {
  label: string;
  icon: IconName;
  items: RecordMenuItem[];
  /** The trigger is the icon alone, named by `label`. */
  iconOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  return (
    <span className="ob-leadrec-menu">
      {iconOnly ? (
        <IconButton
          icon={icon}
          label={label}
          variant="bordered"
          aria-expanded={open}
          onClick={() => setOpen((was) => !was)}
        />
      ) : (
        <Button
          variant="secondary"
          size="sm"
          icon={icon}
          aria-expanded={open}
          onClick={() => setOpen((was) => !was)}
        >
          {label}
          <Icon name="chevron-down" size={14} />
        </Button>
      )}
      <Popover open={open} onClose={() => setOpen(false)}>
        <div className="ob-menu" role="menu">
          {items.map((item) =>
            item.href ? (
              <a
                key={item.label}
                role="menuitem"
                className="ob-menu-item"
                href={item.href}
                target="_blank"
                rel="noreferrer"
                onClick={() => setOpen(false)}
              >
                {item.label}
              </a>
            ) : (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                className={item.danger ? 'ob-menu-item ob-menu-item--danger' : 'ob-menu-item'}
                onClick={() => {
                  setOpen(false);
                  item.onSelect?.();
                }}
              >
                {item.label}
              </button>
            ),
          )}
        </div>
      </Popover>
    </span>
  );
}

/**
 * The stage as a pill in the header; with `onMove` it opens the stage list.
 * A converted order shows Converted and does not move.
 */
export function LeadStageMenu({
  lead,
  stages,
  onMove,
}: {
  lead: Lead;
  stages: PipelineStage[];
  onMove?: (stageId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (lead.convertedOrderId) return <StatusPill tone="ok">{t('lead.badge.converted')}</StatusPill>;
  const tone = stageTone(stages.find((stage) => stage.id === lead.stageId));
  if (!onMove) return <StatusPill tone={tone}>{lead.stageName}</StatusPill>;
  return (
    <span className="ob-leadrec-menu">
      <button
        type="button"
        className={`ob-pill ob-leadrec-stage${tone !== 'default' ? ` ob-pill--${tone}` : ''}`}
        aria-label={t('lead.detail.stageLabel')}
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <span className="ob-leadrec-dot" aria-hidden />
        {lead.stageName}
        <Icon name="chevron-down" size={12} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)}>
        <div className="ob-menu" role="menu">
          {stages.map((stage) => (
            <button
              key={stage.id}
              type="button"
              role="menuitem"
              className="ob-menu-item"
              aria-current={stage.id === lead.stageId || undefined}
              onClick={() => {
                setOpen(false);
                if (stage.id !== lead.stageId) onMove(stage.id);
              }}
            >
              {stage.name}
              {stage.id === lead.stageId && (
                <span className="ob-menu-hint">
                  <Icon name="check" size={14} />
                </span>
              )}
            </button>
          ))}
        </div>
      </Popover>
    </span>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ob-leadrec-fact">
      <span className="ob-leadrec-fact-label">{label}</span>
      <span className="ob-leadrec-fact-value">{children}</span>
    </div>
  );
}

export function LeadRecordView({
  lead,
  optionLists,
  packagingRequired,
  party,
  canEdit,
  canConvert,
  transport,
  onEdit,
  onConverted,
  onOpenOrder,
  onError,
}: LeadRecordViewProps) {
  // Read through a ref so a transport built inline never re-runs anything.
  const transportRef = useRef(transport);
  transportRef.current = transport;

  const [remark, setRemark] = useState('');
  const [dispatchLabel, setDispatchLabel] = useState('');
  const [expectedDate, setExpectedDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [asideClosed, setAsideClosed] = useState(false);
  const colourHex = useColourHex(optionLists);
  const labelOf = useColourLabel(optionLists);

  // "Save all and update": a remark, a dispatch label or a date typed on the new
  // order and not yet used is named. Back asks first. The label and date count only
  // while the Convert card shows them: once the lead is converted (here, or on
  // another PC) they were used or can no longer be.
  const typed =
    remark.trim() ||
    (canConvert && !lead.convertedOrderId ? dispatchLabel.trim() || expectedDate.trim() : '');
  useUnsavedWork(
    `lead-remark:${lead.id}`,
    typed ? { label: t('updates.saveAll.recordNote', { text: typed.slice(0, 40) }) } : null,
  );

  async function run(action: () => Promise<unknown>, failure: MessageKey): Promise<void> {
    setBusy(true);
    try {
      await action();
    } catch (caught) {
      onError(apiErrorText(caught, failure));
    } finally {
      setBusy(false);
    }
  }

  const missingPackaging = packagingRequired
    ? lead.items.filter((item) => !item.packaging?.trim())
    : [];
  const lineCount = lead.items.length;
  const totalPieces = lead.items.reduce((sum, item) => sum + item.quantity, 0);
  const noWeight = lead.linesWithoutWeight;
  const linesText = t(lineCount === 1 ? 'lead.detail.linesOne' : 'lead.detail.lines', {
    count: lineCount,
  });
  const piecesText = `${totalPieces} ${t('unit.pieces')}`;

  function colourOf(item: LineItem): string | null {
    if (item.colour) return item.colour;
    // Not when it only repeats the name (CATALOGUE_MODEL §2).
    if (item.variantLabel && shownColour(item.variantLabel, item.productName)) return item.variantLabel;
    return null;
  }

  async function addRemark(): Promise<void> {
    await run(async () => {
      await transportRef.current.addLeadRemark(lead.id, remark.trim());
      setRemark('');
    }, 'lead.error.addNote');
  }

  const history = [...lead.timeline].reverse();

  return (
    <div className="ob-leadrec">
      {lead.incomplete && (
        <ConflictBanner>
          {t('lead.detail.incompleteWarning', { fields: lead.missingFields.join(', ') })}
        </ConflictBanner>
      )}

      <div className="ob-card ob-leadrec-facts">
        <Fact label={t('lead.detail.party')}>
          <span className="ob-leadrec-party">{lead.partyName}</span>
          {party?.partyCode && <span className="ob-mono ob-small">{party.partyCode}</span>}
        </Fact>
        <Fact label={t('lead.detail.phone')}>
          {party?.phone ? (
            <>
              <span className="ob-data">{party.phone}</span>
              <CopyButton value={party.phone} label={t('lead.detail.copyPhone')} iconOnly />
            </>
          ) : (
            '—'
          )}
        </Fact>
        <Fact label={t('lead.detail.city')}>{party?.city || '—'}</Fact>
        <Fact label={t('lead.detail.source')}>{lead.sourcePlatform || '—'}</Fact>
        <Fact label={t('lead.detail.followUp')}>
          {lead.followUpDate ? (
            <>
              <span className="ob-data">{dayText(lead.followUpDate)}</span>
              <span className="ob-small ob-leadrec-muted">{dayDistance(lead.followUpDate)}</span>
            </>
          ) : (
            '—'
          )}
          {onEdit && (
            <IconButton icon="edit" label={t('lead.detail.editFollowUp')} size={14} onClick={onEdit} />
          )}
        </Fact>
        <Fact label={t('lead.detail.productNames')}>
          {lead.partyWiseMode ? t('lead.detail.productNames.party') : t('lead.detail.productNames.catalogue')}
        </Fact>
        <Fact
          label={
            lead.ownerName
              ? t('lead.detail.createdBy', { name: lead.ownerName })
              : t('lead.detail.created')
          }
        >
          {formatDateTime(lead.createdAt)}
        </Fact>
      </div>

      <div className="ob-leadrec-grid" data-aside-closed={asideClosed || undefined}>
        <div className="ob-card ob-leadrec-lines">
          <div className="ob-leadrec-cardhead">
            <span className="ob-eyebrow">{t('lead.detail.lineItems')}</span>
            <span className="ob-small ob-leadrec-muted">
              {linesText} · {piecesText}
            </span>
          </div>

          {noWeight > 0 && lineCount > 0 && (
            <div className="ob-leadrec-warn" role="status">
              <Icon name="warning" size={16} />
              <span>
                {lineCount === 1 && noWeight === 1
                  ? t('lead.detail.weightBand.one')
                  : noWeight === lineCount
                  ? t('lead.detail.weightBand.all', { count: lineCount })
                  : t('lead.detail.weightBand.some', { count: noWeight, total: lineCount })}
              </span>
              {onEdit && (
                <Button size="sm" variant="secondary" onClick={onEdit}>
                  {t('lead.detail.addWeights')}
                </Button>
              )}
            </div>
          )}

          <table className="ob-leadrec-table">
            <thead>
              <tr>
                <th className="ob-leadrec-num">#</th>
                <th>{t('lead.detail.col.item')}</th>
                <th>{t('lead.detail.col.colour')}</th>
                <th>{t('lead.detail.col.packaging')}</th>
                <th>{t('lead.detail.col.grade')}</th>
                <th>{t('lead.detail.col.weight')}</th>
                <th className="ob-leadrec-qty">{t('lead.detail.col.qty')}</th>
              </tr>
            </thead>
            <tbody>
              {lead.items.map((item, index) => {
                const colour = colourOf(item);
                return (
                  <tr key={item.id}>
                    <td className="ob-leadrec-num">{index + 1}</td>
                    <td>
                      <div className="ob-leadrec-item">
                        <span className="ob-body-strong">{item.productName}</span>
                        {item.categoryName && <span> {item.categoryName}</span>}
                      </div>
                      <div className="ob-mono ob-small ob-leadrec-muted">
                        {item.code}
                        {item.code && item.size ? ' · ' : ''}
                        {item.size}
                      </div>
                    </td>
                    <td>
                      {colour ? (
                        <span className="ob-colourname">
                          <ColourChip name={labelOf(colour)} hex={colourHex(colour)} />
                          <span>{labelOf(colour)}</span>
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      {item.packaging ? (
                        <StatusPill>{item.packaging}</StatusPill>
                      ) : packagingRequired ? (
                        <StatusPill tone="conflict">{t('lead.detail.packagingNotChosen')}</StatusPill>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>{item.grade ? <StatusPill>{item.grade}</StatusPill> : '—'}</td>
                    <td>
                      {item.weightKg === null ? (
                        onEdit ? (
                          <button type="button" className="ob-leadrec-addweight" onClick={onEdit}>
                            {t('lead.detail.addWeight')}
                          </button>
                        ) : (
                          <StatusPill tone="offline">{t('product.weight.missing')}</StatusPill>
                        )
                      ) : (
                        <span
                          className="ob-data"
                          title={t('lead.detail.line.weight', {
                            each: formatKg(item.weightKg),
                            total: formatKg(item.lineWeightKg),
                          })}
                        >
                          {formatKg(item.lineWeightKg)}
                        </span>
                      )}
                    </td>
                    <td className="ob-leadrec-qty">
                      <span className="ob-data ob-body-strong">{item.quantity}</span>{' '}
                      <span className="ob-small ob-leadrec-muted">{t('unit.pieces')}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {onEdit && (
            <button type="button" className="ob-leadrec-addproduct" onClick={onEdit}>
              <Icon name="plus" size={16} />
              {t('lead.detail.addProduct')}
            </button>
          )}

          <div className="ob-leadrec-total">
            <span className="ob-body-strong">
              {t('lead.detail.totalLines')} · {linesText}
            </span>
            <span>
              <span className="ob-data">{formatKg(lead.totalWeightKg)}</span>
              {noWeight > 0 && (
                <span className="ob-small ob-leadrec-warntext">
                  {' · '}
                  {t('lead.detail.weightMissing', { count: noWeight })}
                </span>
              )}
            </span>
            <span className="ob-leadrec-qty">
              <span className="ob-data ob-body-strong">{totalPieces}</span>{' '}
              <span className="ob-small ob-leadrec-muted">{t('unit.pieces')}</span>
            </span>
          </div>
        </div>

        <aside className="ob-card ob-leadrec-aside">
          <div className="ob-leadrec-cardhead">
            {!asideClosed && <span className="ob-eyebrow">{t('lead.detail.nextStep')}</span>}
            <IconButton
              icon={asideClosed ? 'chevron-left' : 'chevron-right'}
              label={asideClosed ? t('lead.detail.asideOpen') : t('lead.detail.asideClose')}
              onClick={() => setAsideClosed((was) => !was)}
            />
          </div>

          {!asideClosed && (
            <>
              <div className="ob-leadrec-asidebody">
                {lead.convertedOrderId ? (
                  <div className="ob-leadrec-convert" data-done>
                    <StatusPill tone="ok">{t('lead.badge.converted')}</StatusPill>
                    <p className="ob-small">
                      {t('lead.detail.convertedMessage', {
                        // A final order shows its new order's number.
                        orderId: recordNumberText({ id: lead.convertedOrderId, poNumber: lead.poNumber }),
                      })}
                    </p>
                    {onOpenOrder && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => onOpenOrder(lead.convertedOrderId as string)}
                      >
                        {t('lead.board.menu.open')}
                      </Button>
                    )}
                  </div>
                ) : (
                  canConvert && (
                    <div className="ob-leadrec-convert">
                      <h3 className="ob-leadrec-convert-title">{t('lead.detail.convertTitle')}</h3>
                      <p className="ob-small">{t('lead.detail.convertDesc')}</p>
                      <ul className="ob-leadrec-checks">
                        <li data-tone="ok">
                          <Icon name="check" size={14} />
                          {t('lead.detail.check.ready', { lines: linesText, pieces: piecesText })}
                        </li>
                        {missingPackaging.length > 0 && (
                          <li data-tone="conflict">
                            <Icon name="warning" size={14} />
                            {t('lead.detail.convertMissingPackaging', {
                              names: missingPackaging.map((item) => item.productName).join(', '),
                            })}
                          </li>
                        )}
                        {noWeight > 0 && (
                          <li data-tone="warn">
                            <Icon name="warning" size={14} />
                            {noWeight === lineCount
                              ? t('lead.detail.check.noWeights')
                              : t('lead.detail.check.someWeights', { count: noWeight })}
                          </li>
                        )}
                      </ul>

                      <FormField label={t('lead.detail.dispatchLabel')}>
                        {(id) => (
                          <Input
                            id={id}
                            value={dispatchLabel}
                            placeholder={t('lead.detail.dispatchPlaceholder')}
                            onChange={(event) => setDispatchLabel(event.target.value)}
                          />
                        )}
                      </FormField>

                      <FormField label={t('lead.detail.expectedDate')}>
                        {(id) => (
                          <div className="ob-leadrec-dateRow">
                            <DateField
                              id={id}
                              value={expectedDate}
                              onChange={(event) => setExpectedDate(event.target.value)}
                            />
                            <div className="ob-leadrec-quick" role="group">
                              {(
                                [
                                  [0, 'lead.detail.quick.today'],
                                  [1, 'lead.detail.quick.plus1'],
                                  [3, 'lead.detail.quick.plus3'],
                                ] as const
                              ).map(([offset, key]) => (
                                <button
                                  key={key}
                                  type="button"
                                  aria-pressed={expectedDate === localIsoDate(offset)}
                                  onClick={() => setExpectedDate(localIsoDate(offset))}
                                >
                                  {t(key)}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </FormField>

                      <Button
                        variant="primary"
                        icon="external"
                        className="ob-leadrec-convert-go"
                        disabled={busy || missingPackaging.length > 0}
                        onClick={() =>
                          void run(async () => {
                            const order = await transportRef.current.convertLead(lead.id, {
                              dispatchAddressLabel: dispatchLabel.trim() || null,
                              expectedDispatchDate: expectedDate || null,
                            });
                            // Used up: this view stays mounted behind the new order.
                            setDispatchLabel('');
                            setExpectedDate('');
                            onConverted(order);
                          }, 'lead.error.convert')
                        }
                      >
                        {t('lead.detail.convertAction')}
                      </Button>
                    </div>
                  )
                )}

                <div className="ob-leadrec-history">
                  <div className="ob-leadrec-history-head">
                    <span className="ob-body-strong">{t('lead.detail.history')}</span>
                    <span className="ob-pill">{history.length}</span>
                  </div>
                  {history.length === 0 ? (
                    <p className="ob-small">{t('lead.detail.noHistory')}</p>
                  ) : (
                    <ul>
                      {history.map((entry) => (
                        <li key={entry.id} data-system={entry.kind === 'system' || undefined}>
                          <Avatar name={entry.actorName ?? '?'} avatar={null} size="sm" />
                          <div>
                            <div>
                              {entry.actorName && <span className="ob-body-strong">{entry.actorName} </span>}
                              <span>{entry.message}</span>
                            </div>
                            <div className="ob-small ob-data ob-leadrec-muted">
                              {formatDateTime(entry.createdAt)}
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>

              {canEdit && (
                <form
                  className="ob-leadrec-note"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!busy && remark.trim()) void addRemark();
                  }}
                >
                  <Input
                    value={remark}
                    placeholder={t('lead.detail.addNotePlaceholder')}
                    onChange={(event) => setRemark(event.target.value)}
                  />
                  <Button type="submit" disabled={busy || !remark.trim()}>
                    {t('lead.detail.addNote')}
                  </Button>
                </form>
              )}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
