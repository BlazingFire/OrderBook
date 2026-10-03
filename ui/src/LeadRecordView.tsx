/**
 * One pending order (lead) in full: its lines, its history, and the two things
 * a person does to it — move it along, or convert it.
 *
 * Port of `office/web/src/screens/LeadDetail.tsx`; keep in step. The Office
 * copy reads its data from the local snapshot and writes through the outbox;
 * this one is handed the record and a transport, so the Master can mount it
 * over its own HTTP client. Deliberate differences from the Office copy:
 *  - the stage select, "Add note" and the Convert card are **absent**, not
 *    disabled, without the matching permission (the Office leaves them open and
 *    lets the Master refuse);
 *  - converting hands the new order to `onConverted` rather than closing.
 *
 * Rendered as the body of an `EditorScreen` — the party name, id and way back
 * live in its header, not here.
 */

import { useRef, useState } from 'react';
import { shownColour } from '@orderbook/shared';
import type { MessageKey } from '@orderbook/shared';
import type { Lead, OptionListItem, Order, Party, PipelineStage } from '@orderbook/shared';

import { Button } from './Button.js';
import { Card } from './Card.js';
import { ColourChip, KeyValueList, StatusPill, Timeline, useColourHex } from './DataDisplay.js';
import { DateField, FormField, Input } from './Form.js';
import { formatDateTime, formatKg } from './format.js';
import { apiErrorText } from './errorText.js';
import { t } from './i18n.js';
import { recordNumberText } from './RecordNumber.js';
import { Select } from './SuggestInput.js';
import { ConflictBanner } from './States.js';

/** What this view may reach. Held in a ref: callers build the object inline. */
export interface LeadRecordTransport {
  addLeadRemark: (id: string, message: string) => Promise<unknown>;
  setLeadStage: (id: string, stageId: string) => Promise<unknown>;
  convertLead: (
    id: string,
    input: { dispatchAddressLabel: string | null; expectedDispatchDate: string | null },
  ) => Promise<Order>;
}

export interface LeadRecordViewProps {
  lead: Lead;
  /** The lead pipeline's stages, in order. */
  stages: PipelineStage[];
  optionLists: OptionListItem[];
  /** `leads.packagingRequiredOnConvert`, already resolved by the caller. */
  packagingRequired: boolean;
  /** The party's own record, or null when the caller may not read it. */
  party: Party | null;
  /** `leads.edit`: the stage select and Add note. */
  canEdit: boolean;
  /** `lead.convert`: the Convert card. */
  canConvert: boolean;
  transport: LeadRecordTransport;
  onConverted: (order: Order) => void;
  onOpenOrder: (orderId: string) => void;
  onError: (message: string) => void;
}

export function LeadRecordView({
  lead,
  stages,
  optionLists,
  packagingRequired,
  party,
  canEdit,
  canConvert,
  transport,
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
  const colourHex = useColourHex(optionLists);

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
  const totalPieces = lead.items.reduce((sum, item) => sum + item.quantity, 0);

  return (
    <div className="ob-record-grid">
      <div className="ob-detail-main">
        {lead.incomplete && (
          <ConflictBanner>
            {t('lead.detail.incompleteWarning', { fields: lead.missingFields.join(', ') })}
          </ConflictBanner>
        )}

        <Card padded={false}>
          <div className="ob-detail-head">
            <span className="ob-eyebrow">{t('lead.detail.lineItems')}</span>
            <span style={{ flex: 1 }} />
            <span className="ob-small">
              {lead.items.length} · {totalPieces} {t('unit.pieces')}
            </span>
          </div>
          <div className="ob-lines">
            {lead.items.map((item) => (
              <div key={item.id} className="ob-line">
                <div className="ob-line-body">
                  <div className="ob-line-head">
                    {item.code && <span className="ob-mono ob-body-strong">{item.code}</span>}
                    <span className="ob-body-strong">{item.productName}</span>
                    {/* Not when it only repeats the name (CATALOGUE_MODEL §2). */}
                    {item.variantLabel && shownColour(item.variantLabel, item.productName) && (
                      <span className="ob-colourname ob-small">
                        <ColourChip name={item.variantLabel} hex={colourHex(item.variantLabel)} />
                        <span>{item.variantLabel}</span>
                      </span>
                    )}
                    {item.colour && (
                      <span className="ob-colourname ob-small">
                        <ColourChip name={item.colour} hex={colourHex(item.colour)} />
                        <span>{item.colour}</span>
                      </span>
                    )}
                    <span className="ob-small" style={{ color: 'var(--fg-tertiary)' }}>
                      {[item.categoryName, item.size].filter(Boolean).join(' · ')}
                    </span>
                  </div>
                  <div className="ob-line-meta">
                    {item.packaging ? (
                      <StatusPill>{item.packaging}</StatusPill>
                    ) : (
                      packagingRequired && (
                        <StatusPill tone="conflict">
                          {t('lead.detail.packagingNotChosen')}
                        </StatusPill>
                      )
                    )}
                    {item.grade && <StatusPill>{item.grade}</StatusPill>}
                    {item.weightKg === null ? (
                      <StatusPill tone="offline">{t('product.weight.missing')}</StatusPill>
                    ) : (
                      <span className="ob-small" style={{ color: 'var(--fg-tertiary)' }}>
                        {t('lead.detail.line.weight', {
                          each: formatKg(item.weightKg),
                          total: formatKg(item.lineWeightKg),
                        })}
                      </span>
                    )}
                  </div>
                </div>
                <div className="ob-line-figures">
                  <span className="ob-data ob-body-strong">
                    {item.quantity} {t('unit.pieces')}
                  </span>
                </div>
              </div>
            ))}
          </div>
          <div className="ob-detail-foot">
            <span className="ob-small">{t('lead.detail.totalWeight')}</span>
            <span className="ob-body-strong ob-data">{formatKg(lead.totalWeightKg)}</span>
            {lead.linesWithoutWeight > 0 && (
              <StatusPill tone="offline">
                {t(
                  lead.linesWithoutWeight === 1
                    ? 'lead.detail.linesWithoutWeightOne'
                    : 'lead.detail.linesWithoutWeight',
                  { count: lead.linesWithoutWeight },
                )}
              </StatusPill>
            )}
          </div>
        </Card>

        <Card>
          <div className="ob-eyebrow" style={{ marginBottom: 'var(--s-8)' }}>
            {t('lead.detail.history')}
          </div>
          {lead.timeline.length === 0 ? (
            <p className="ob-small">{t('lead.detail.noHistory')}</p>
          ) : (
            <Timeline
              entries={lead.timeline.map((entry) => ({
                id: entry.id,
                label: (
                  <>
                    {entry.message}
                    {entry.actorName ? ` · ${entry.actorName}` : ''}
                  </>
                ),
                when: formatDateTime(entry.createdAt),
              }))}
            />
          )}

          {canEdit && (
            <div style={{ display: 'flex', gap: 'var(--s-8)', marginTop: 'var(--s-12)' }}>
              <Input
                value={remark}
                placeholder={t('lead.detail.addNotePlaceholder')}
                onChange={(event) => setRemark(event.target.value)}
              />
              <Button
                disabled={busy || !remark.trim()}
                onClick={() =>
                  void run(async () => {
                    await transportRef.current.addLeadRemark(lead.id, remark.trim());
                    setRemark('');
                  }, 'lead.error.addNote')
                }
              >
                {t('lead.detail.addNote')}
              </Button>
            </div>
          )}
        </Card>
      </div>

      <div className="ob-detail-aside">
        {canEdit && (
          <Card>
            <FormField label={t('lead.detail.stageLabel')}>
              {(id) => (
                <Select
                  id={id}
                  value={lead.stageId}
                  disabled={busy || Boolean(lead.convertedOrderId)}
                  onChange={(event) =>
                    void run(
                      () => transportRef.current.setLeadStage(lead.id, event.target.value),
                      'lead.error.move',
                    )
                  }
                >
                  {stages.map((stage) => (
                    <option key={stage.id} value={stage.id}>
                      {stage.name}
                    </option>
                  ))}
                </Select>
              )}
            </FormField>
          </Card>
        )}

        <Card>
          <div className="ob-eyebrow" style={{ marginBottom: 'var(--s-8)' }}>
            {t('lead.detail.party')}
          </div>
          <KeyValueList
            items={[
              { label: t('lead.detail.name'), value: lead.partyName },
              {
                label: t('lead.detail.code'),
                value: <span className="ob-mono">{party?.partyCode ?? '—'}</span>,
              },
              { label: t('lead.detail.phone'), value: party?.phone ?? '—' },
              { label: t('lead.detail.city'), value: party?.city ?? '—' },
              { label: t('lead.detail.source'), value: lead.sourcePlatform ?? '—' },
            ]}
          />
        </Card>

        <Card>
          <div className="ob-eyebrow" style={{ marginBottom: 'var(--s-8)' }}>
            {t('lead.detail.details')}
          </div>
          <KeyValueList
            items={[
              { label: t('lead.detail.followUp'), value: lead.followUpDate ?? '—' },
              {
                // "Party-wise records": the key's name predates the removal of
                // pricing, the text names no money.
                label: t('lead.detail.partyRates'),
                value: lead.partyWiseMode ? t('lead.detail.yes') : t('lead.detail.no'),
              },
              { label: t('lead.detail.created'), value: formatDateTime(lead.createdAt) },
            ]}
          />
          {lead.notes && (
            <p className="ob-small" style={{ marginTop: 'var(--s-8)' }}>
              {lead.notes}
            </p>
          )}
        </Card>

        {lead.convertedOrderId ? (
          <Card style={{ background: 'var(--state-ok-tint)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-8)' }}>
              <StatusPill tone="ok">{t('lead.badge.converted')}</StatusPill>
              <span className="ob-small" style={{ color: 'var(--fg-primary)' }}>
                {t('lead.detail.convertedMessage', {
                  // A final order shows its pending order's number.
                  orderId: recordNumberText({ id: lead.convertedOrderId, poNumber: lead.poNumber }),
                })}
              </span>
            </div>
            <div style={{ marginTop: 'var(--s-8)' }}>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => onOpenOrder(lead.convertedOrderId as string)}
              >
                {t('lead.board.menu.open')}
              </Button>
            </div>
          </Card>
        ) : (
          canConvert && (
            <Card>
              <div className="ob-eyebrow" style={{ marginBottom: 'var(--s-8)' }}>
                {t('lead.detail.convertTitle')}
              </div>
              <p className="ob-small" style={{ margin: 0 }}>
                {t('lead.detail.convertDesc')}
              </p>

              {missingPackaging.length > 0 && (
                <ConflictBanner>
                  {t('lead.detail.convertMissingPackaging', {
                    names: missingPackaging.map((item) => item.productName).join(', '),
                  })}
                </ConflictBanner>
              )}

              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--s-12)',
                  marginTop: 'var(--s-12)',
                }}
              >
                <FormField label={t('lead.detail.dispatchLabel')}>
                  {(id) => (
                    <Input
                      id={id}
                      value={dispatchLabel}
                      onChange={(event) => setDispatchLabel(event.target.value)}
                    />
                  )}
                </FormField>

                <FormField label={t('lead.detail.expectedDate')}>
                  {(id) => (
                    <DateField
                      id={id}
                      value={expectedDate}
                      onChange={(event) => setExpectedDate(event.target.value)}
                    />
                  )}
                </FormField>

                <div>
                  <Button
                    variant="primary"
                    disabled={busy || missingPackaging.length > 0}
                    onClick={() =>
                      void run(async () => {
                        const order = await transportRef.current.convertLead(lead.id, {
                          dispatchAddressLabel: dispatchLabel.trim() || null,
                          expectedDispatchDate: expectedDate || null,
                        });
                        onConverted(order);
                      }, 'lead.error.convert')
                    }
                  >
                    {t('lead.detail.convertAction')}
                  </Button>
                </div>
              </div>
            </Card>
          )
        )}
      </div>
    </div>
  );
}
