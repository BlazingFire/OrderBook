/**
 * One final order (order) in full: its lines, weight, stage,
 * history and the Dispatch action.
 *
 * Port of `OrderDetailBody` in `office/web/src/screens/OrderBoardScreen.tsx`;
 * keep in step. The Office copy writes through its outbox; this one is handed
 * the record and a transport so the Master can mount it over its own HTTP
 * client. Deliberate differences from the Office copy:
 *  - the stage select and the weight override are **absent** without
 *    `orders.edit`, and the Dispatch card without `orders.dispatch` — absent,
 *    not disabled with a note, as everywhere else on the Master;
 *  - dispatching hands the saved order to `onDispatched` rather than closing.
 *
 * Rendered as the body of an `EditorScreen` — the party name, stage pill and
 * way back live in its header, not here.
 */

import { useRef, useState } from 'react';
import { shownColour } from '@orderbook/shared';
import type { MessageKey, OptionListItem, Order, PipelineStage } from '@orderbook/shared';

import { Button } from './Button.js';
import { Card, Section } from './Card.js';
import {
  ColourName,
  StatusPill,
  Timeline,
  recordTimelineEntries,
  useColourHex,
} from './DataDisplay.js';
import { FormField, Input, NumberInput } from './Form.js';
import { formatDateTime, formatKg } from './format.js';
import { apiErrorText } from './errorText.js';
import { t } from './i18n.js';
import { useUnsavedWork } from './unsavedWork.js';
import { Select } from './SuggestInput.js';

/**
 * Whether the order header needs the "dispatched" pill beside its stage pill.
 * Dispatch moves the order to the stage named Dispatched, and then the stage
 * pill already says it: two pills reading "Dispatched dispatched" was noise.
 * The pill still shows when that stage was renamed and the order stayed on
 * another one (see `dispatchOrder` in the Master's order service).
 */
export function showsDispatchedPill(order: Pick<Order, 'dispatchedAt' | 'stageName'>): boolean {
  return Boolean(order.dispatchedAt) && order.stageName.trim().toLowerCase() !== 'dispatched';
}

/** What this view may reach. Held in a ref: callers build the object inline. */
export interface OrderRecordTransport {
  updateOrder: (id: string, input: { totalWeightKgOverride: number | null }) => Promise<unknown>;
  setOrderStage: (id: string, stageId: string) => Promise<unknown>;
  dispatchOrder: (id: string, note: string | null) => Promise<Order>;
}

export interface OrderRecordViewProps {
  order: Order;
  /** The order pipeline's stages, in order. */
  stages: PipelineStage[];
  optionLists: OptionListItem[];
  /** `orders.edit`: the stage select and the weight override. */
  canEdit: boolean;
  /** `orders.dispatch`: the Dispatch card. */
  canDispatch: boolean;
  transport: OrderRecordTransport;
  onDispatched: (order: Order) => void;
  onError: (message: string) => void;
}

export function OrderRecordView({
  order,
  stages,
  optionLists,
  canEdit,
  canDispatch,
  transport,
  onDispatched,
  onError,
}: OrderRecordViewProps) {
  const transportRef = useRef(transport);
  transportRef.current = transport;

  const colourHex = useColourHex(optionLists);
  const [note, setNote] = useState('');
  const [override, setOverride] = useState(
    order.totalWeightKgOverride === null ? '' : String(order.totalWeightKgOverride),
  );
  /*
   * The override as this screen last sent it — or as the order held it when the
   * screen opened. Leaving the field is what saves it, and a blur writes only
   * when the field no longer says this, so a Tab through the form is not an
   * order update. A ref, set as a send starts, so an edit typed while that send
   * is on its way is compared with what it sent.
   */
  const sentOverride = useRef(order.totalWeightKgOverride);
  const overrideValue = override === '' ? null : Number(override);
  const overrideInvalid = overrideValue !== null && Number.isNaN(overrideValue);
  const [busy, setBusy] = useState(false);

  // "Save all and update": a note typed on the order and not yet added is named.
  useUnsavedWork(
    `order-note:${order.id}`,
    note.trim() ? { label: t('updates.saveAll.recordNote', { text: note.trim().slice(0, 40) }) } : null,
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

  function saveOverride(): void {
    // "1.2.3" survives the character filter and is no number; sent, it would
    // arrive as `null` and quietly clear the override. The field says it is
    // wrong instead and nothing is written.
    if (overrideInvalid || overrideValue === sentOverride.current) return;
    const before = sentOverride.current;
    const value = overrideValue;
    sentOverride.current = value;
    void run(async () => {
      try {
        await transportRef.current.updateOrder(order.id, { totalWeightKgOverride: value });
      } catch (caught) {
        // Not saved, so the next blur tries again.
        if (sentOverride.current === value) sentOverride.current = before;
        throw caught;
      }
    }, 'orders.error.saveWeight');
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
      <Card>
        <Section title={t('orders.detail.products')}>
          <div className="ob-tablewrap">
            <table className="ob-table ob-table--flat">
              <thead>
                <tr>
                  <th>{t('orders.column.code')}</th>
                  <th>{t('orders.column.product')}</th>
                  <th>{t('orders.column.variant')}</th>
                  <th>{t('orders.column.colour')}</th>
                  <th>{t('orders.column.packaging')}</th>
                  <th>{t('orders.column.grade')}</th>
                  <th className="num">{t('orders.column.qty')}</th>
                  <th className="num">{t('orders.column.lineWeight')}</th>
                </tr>
              </thead>
              <tbody>
                {order.items.map((item) => (
                  <tr key={item.id}>
                    <td className="ob-mono">{item.code ?? '—'}</td>
                    <td>
                      {item.productName}
                      <div className="ob-small">
                        {[item.categoryName, item.size].filter(Boolean).join(' · ')}
                      </div>
                    </td>
                    <td>
                      {/* Not when it only repeats the name (CATALOGUE_MODEL §2). */}
                      {item.variantLabel && shownColour(item.variantLabel, item.productName) ? (
                        <ColourName name={item.variantLabel} hex={colourHex(item.variantLabel)} />
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      {item.colour ? (
                        <ColourName name={item.colour} hex={colourHex(item.colour)} />
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>{item.packaging ?? '—'}</td>
                    <td>{item.grade ?? '—'}</td>
                    <td className="num">{item.quantity.toLocaleString('en-IN')}</td>
                    <td className="num">
                      {/* Frozen on the line when it was raised. */}
                      {item.lineWeightKg === null ? (
                        <StatusPill tone="offline">{t('product.weight.missing')}</StatusPill>
                      ) : (
                        formatKg(item.lineWeightKg)
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      </Card>

      <Card>
        <Section title={t('orders.detail.weight')}>
          <p className="ob-small" style={{ marginTop: 0 }}>
            {t('orders.detail.weightComputed', {
              value: order.totalWeightKg.toLocaleString('en-IN'),
            })}
          </p>
          {order.linesWithoutWeight > 0 && (
            <p className="ob-small" style={{ marginTop: 0 }}>
              <StatusPill tone="offline">
                {t(
                  order.linesWithoutWeight === 1
                    ? 'orders.detail.linesWithoutWeightOne'
                    : 'orders.detail.linesWithoutWeight',
                  { count: order.linesWithoutWeight },
                )}
              </StatusPill>
            </p>
          )}

          {canEdit && (
            <FormField
              label={t('orders.detail.weightOverrideLabel')}
              error={overrideInvalid ? t('orders.detail.weightOverrideInvalid') : undefined}
            >
              {(id) => (
                <NumberInput
                  id={id}
                  value={override}
                  invalid={overrideInvalid}
                  onChange={(event) => setOverride(event.target.value.replace(/[^0-9.]/g, ''))}
                  placeholder={t('orders.detail.weightOverridePlaceholder')}
                  onBlur={saveOverride}
                />
              )}
            </FormField>
          )}

          <p className="ob-small" style={{ marginBottom: 0 }}>
            {t('orders.detail.weightShowing', { source: order.weightSource })}
          </p>
        </Section>
      </Card>

      {canEdit && (
        <Card>
          <Section title={t('orders.detail.stage')}>
            <FormField label={t('orders.detail.stageLabel')}>
              {(id) => (
                <Select
                  id={id}
                  value={order.stageId}
                  disabled={busy || Boolean(order.dispatchedAt)}
                  onChange={(event) =>
                    void run(
                      () => transportRef.current.setOrderStage(order.id, event.target.value),
                      'orders.error.move',
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
          </Section>
        </Card>
      )}

      <Card>
        <Section title={t('orders.detail.history')}>
          <Timeline entries={recordTimelineEntries(order.timeline, formatDateTime)} />
        </Section>
      </Card>

      {order.dispatchedAt ? (
        <Card style={{ background: 'var(--state-ok-tint)' }}>
          <p className="ob-small" style={{ margin: 0, color: 'var(--fg-primary)' }}>
            {t('orders.detail.dispatchedBanner', { when: formatDateTime(order.dispatchedAt) })}
          </p>
        </Card>
      ) : (
        canDispatch && (
          <Card>
            <Section title={t('orders.detail.dispatch')}>
              <p className="ob-small" style={{ marginTop: 0 }}>
                {t('orders.detail.dispatchNote')}
              </p>

              <FormField label={t('orders.detail.dispatchNoteLabel')}>
                {(id) => (
                  <Input
                    id={id}
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    placeholder={t('orders.detail.dispatchNotePlaceholder')}
                  />
                )}
              </FormField>

              <Button
                variant="primary"
                busy={busy}
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const saved = await transportRef.current.dispatchOrder(
                      order.id,
                      note.trim() || null,
                    );
                    onDispatched(saved);
                  }, 'orders.error.dispatch')
                }
              >
                {t('orders.detail.dispatchButton')}
              </Button>
            </Section>
          </Card>
        )
      )}
    </div>
  );
}
