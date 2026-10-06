/**
 * Stock was removed in 1.4 (R15): an order shows no reservations and no stock
 * held, and the dispatch card says only what dispatching does.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Order } from '@orderbook/shared';

import { t } from '../src/i18n.js';
import { OrderRecordView, showsDispatchedPill } from '../src/OrderRecordView.js';
import { installBrowserStubs } from './panel-harness.js';

beforeEach(() => {
  installBrowserStubs();
});

afterEach(() => {
  cleanup();
});

function order(extra: Record<string, unknown> = {}): Order {
  return {
    id: 'OR0000000001',
    partyId: 'PT0000000001',
    partyName: 'Patel Tiles',
    leadId: null,
    stageId: 's1',
    stageName: 'Booked',
    stageSequence: 1,
    items: [],
    timeline: [],
    totalWeightKg: 0,
    totalWeightKgOverride: null,
    weightSource: 'computed',
    linesWithoutWeight: 0,
    dispatchedAt: null,
    ...extra,
  } as unknown as Order;
}

function renderOrder(value: Order) {
  return render(
    <OrderRecordView
      order={value}
      stages={[]}
      optionLists={[]}
      canEdit
      canDispatch
      transport={{
        updateOrder: vi.fn(),
        setOrderStage: vi.fn(),
        dispatchOrder: vi.fn(),
      }}
      onDispatched={() => undefined}
      onError={() => undefined}
    />,
  );
}

describe('the order record', () => {
  it('shows no reservation or stock-held text, and the plain dispatch note', () => {
    renderOrder(order());

    expect(document.body.textContent).not.toMatch(/reservation|reserved|stock held/i);
    expect(screen.getByText(t('orders.detail.dispatchNote'))).toBeTruthy();
  });

  it('ignores reservations an older Master still sends', () => {
    renderOrder(order({ reservations: [{ id: 'RS1', boxes: 2, productName: 'Ivory Basin' }] }));

    expect(document.body.textContent).not.toMatch(/reservation|reserved|stock held/i);
    expect(document.body.textContent).not.toContain('Ivory Basin');
  });
});

describe('the dispatched pill beside the stage pill', () => {
  it('is left out when the stage already says Dispatched, and kept when it does not', () => {
    const at = '2026-10-07T00:00:00.000Z';
    expect(showsDispatchedPill({ dispatchedAt: at, stageName: 'Dispatched' })).toBe(false);
    expect(showsDispatchedPill({ dispatchedAt: at, stageName: ' dispatched ' })).toBe(false);
    // A renamed stage keeps the order where it was, so the pill is the only sign.
    expect(showsDispatchedPill({ dispatchedAt: at, stageName: 'Booked' })).toBe(true);
    expect(showsDispatchedPill({ dispatchedAt: null, stageName: 'Booked' })).toBe(false);
  });
});
