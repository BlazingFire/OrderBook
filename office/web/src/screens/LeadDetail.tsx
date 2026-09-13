/**
 * One lead in full: its lines, its history, and the two things a person does to
 * it — move it along, or convert it (docs/LEAD_GENERATION_FLOW.md §4, §5).
 *
 * The stage `select` here is not a duplicate of the board's drag: dragging is
 * mouse-only, and this is the path that works with a keyboard.
 *
 * Rendered as the body of the sub-screen `LeadBoardScreen` opens — the party
 * name, id, sync/converted badges and the way back live in `EditorScreen`'s
 * header, not here.
 *
 * Two columns, not a stack. The lines and the history are what a person reads;
 * the stage, the party, the facts and the convert action are what they glance
 * at or do — so those sit in a narrow aside that stays the same width from a
 * 1024px floor to a 4K panel, while the lines take the rest. A single stack of
 * full-width cards put every value a screen-width away from its label.
 */

import { useState } from 'react';
import type { Lead } from '@orderbook/shared';

import { api, type LocalView } from '../api';
import {
  Button,
  Card,
  ColourChip,
  ConflictBanner,
  DateField,
  FormField,
  Input,
  KeyValueList,
  Select,
  StatusPill,
  Timeline,
  formatDateTime,
  formatMoney,
  t,
  useColourHex,
} from '@orderbook/ui';

interface Props {
  lead: Lead;
  view: LocalView;
  canConvert: boolean;
  onClose: () => void;
  onError: (message: string) => void;
}

export function LeadDetail({ lead, view, canConvert, onClose, onError }: Props) {
  const [remark, setRemark] = useState('');
  const [dispatchLabel, setDispatchLabel] = useState('');
  const [expectedDate, setExpectedDate] = useState('');
  const [busy, setBusy] = useState(false);
  const colourHex = useColourHex(view.optionLists);
  // Off with the company's pricing switch, or without the role's key.
  const showMoney = view.permissions.includes('field.saleRate.view');

  const pipeline = view.pipelines.find((candidate) => candidate.kind === 'lead');
  const stages = [...(pipeline?.stages ?? [])].sort((a, b) => a.sequence - b.sequence);
  const party = view.parties.find((candidate) => candidate.id === lead.partyId) ?? null;

  async function run(action: () => Promise<unknown>, failure: string): Promise<void> {
    setBusy(true);
    try {
      await action();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : failure);
    } finally {
      setBusy(false);
    }
  }

  const missingPackaging = lead.items.filter((item) => !item.packaging?.trim());
  const totalBoxes = lead.items.reduce((sum, item) => sum + item.totalQuantity, 0);

  return (
    <div className="ob-detail-grid">
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
              {lead.items.length} · {totalBoxes} {t('unit.boxes')}
            </span>
          </div>
          <div className="ob-lines">
            {lead.items.map((item) => (
              <div key={item.id} className="ob-line">
                <div className="ob-line-body">
                  <div className="ob-line-head">
                    {/*
                     * The codes first, as on the screen the line was entered
                     * on: `201, 202` is how the counter refers to this line on
                     * the phone, and `item.code` is the product code, which
                     * cannot say which colours were ordered.
                     */}
                    {item.quantities.some((quantity) => quantity.variantCode) && (
                      <span className="ob-mono ob-body-strong">
                        {item.quantities
                          .map((quantity) => quantity.variantCode)
                          .filter(Boolean)
                          .join(', ')}
                      </span>
                    )}
                    <span className="ob-body-strong">{item.productName}</span>
                    <span className="ob-small" style={{ color: 'var(--fg-tertiary)' }}>
                      {item.categoryName ? `${item.categoryName} › ` : ''}
                      {item.code}
                      {item.size ? ` · ${item.size}` : ''}
                      {item.grade ? ` · ${item.grade}` : ''}
                    </span>
                  </div>
                  <div className="ob-line-meta">
                    {item.packaging ? (
                      <StatusPill>{item.packaging}</StatusPill>
                    ) : (
                      <StatusPill tone="conflict">{t('lead.detail.packagingNotChosen')}</StatusPill>
                    )}
                    {item.quantities.map((quantity) => (
                      <span key={quantity.id} className="ob-colourname ob-small">
                        <ColourChip name={quantity.colour} hex={colourHex(quantity.colour)} />
                        <span>
                          {quantity.variantCode ? `${quantity.variantCode} · ` : ''}
                          {quantity.colour} × {quantity.quantity}
                        </span>
                      </span>
                    ))}
                  </div>
                </div>
                <div className="ob-line-figures">
                  <span className="ob-data ob-body-strong">
                    {item.totalQuantity} {t('unit.boxes')}
                  </span>
                  {showMoney && (
                    /*
                     * Three states, and the em dash only covers one of them. A
                     * rate that is present-and-null was deliberately left to be
                     * quoted; a rate that is absent is one this role may not
                     * see, and saying "to be quoted" there would be a claim
                     * about somebody else's price.
                     */
                    <span className="ob-data ob-small">
                      {item.lineTotal != null
                        ? formatMoney(item.lineTotal)
                        : 'rate' in item && item.rate === null
                          ? t('lead.add.line.rateUnset')
                          : '—'}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
          {lead.totalAmount !== undefined && (
            <div className="ob-detail-foot">
              <span className="ob-small">{t('lead.detail.total')}</span>
              <span className="ob-body-strong ob-data">{formatMoney(lead.totalAmount)}</span>
            </div>
          )}
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
                  await api.addLeadRemark(lead.id, remark.trim());
                  setRemark('');
                }, 'Could not add the note')
              }
            >
              {t('lead.detail.addNote')}
            </Button>
          </div>
        </Card>
      </div>

      <div className="ob-detail-aside">
        <Card>
          <FormField label={t('lead.detail.stageLabel')}>
            {(id) => (
              <Select
                id={id}
                value={lead.stageId}
                disabled={busy || Boolean(lead.convertedOrderId)}
                onChange={(event) =>
                  void run(
                    () => api.setLeadStage(lead.id, event.target.value),
                    'Could not move the lead',
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
                {t('lead.detail.convertedMessage', { orderId: lead.convertedOrderId })}
              </span>
            </div>
          </Card>
        ) : (
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

              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-12)' }}>
                <Button
                  variant="primary"
                  disabled={busy || !canConvert || missingPackaging.length > 0}
                  onClick={() =>
                    void run(async () => {
                      await api.convertLead(lead.id, {
                        dispatchAddressLabel: dispatchLabel.trim() || null,
                        expectedDispatchDate: expectedDate || null,
                      });
                      onClose();
                    }, 'Could not convert the lead')
                  }
                >
                  {t('lead.detail.convertAction')}
                </Button>

                {!canConvert && <span className="ob-small">{t('lead.detail.noPermission')}</span>}
              </div>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
