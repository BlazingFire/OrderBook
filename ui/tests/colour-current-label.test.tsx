/**
 * W2 (Master record views): a line stores the colour list's VALUE, so after the colour is
 * renamed in Fields the pending-order and final-order details print the list's current
 * LABEL; a value the list no longer has prints as stored.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Lead, OptionListItem, Order } from '@orderbook/shared';

import { LeadRecordView } from '../src/LeadRecordView.js';
import { OrderRecordView } from '../src/OrderRecordView.js';
import { installBrowserStubs } from './panel-harness.js';

beforeEach(() => {
  installBrowserStubs();
});

afterEach(cleanup);

/** "Ivory" renamed to "Antique Ivory" in Fields; the value stays "Ivory". */
const OPTIONS = [
  { id: 'o1', listKey: 'stock.colour', value: 'Ivory', label: 'Antique Ivory', sequence: 1, isActive: true, hex: '#F1E8CF' },
] as unknown as OptionListItem[];

const LINE = {
  id: 'line-1',
  variantId: 'var-1',
  productId: 'prod-1',
  productName: 'E.W.C - S TRAP',
  code: 'WC-0005',
  categoryName: 'Water Closet',
  size: null,
  brandName: null,
  variantLabel: null,
  colour: 'Ivory',
  grade: null,
  packaging: null,
  quantity: 12,
  weightKg: null,
  lineWeightKg: null,
};

const UNLISTED = { ...LINE, id: 'line-2', colour: 'Sea Green' };

describe('the Master record views print a colour by its current label', () => {
  it('pending-order detail (LeadRecordView)', () => {
    const lead = {
      id: 'LD0000000001',
      partyId: 'PT0000000001',
      partyName: 'Patel Tiles',
      stageId: 's1',
      stageName: 'New',
      items: [LINE, UNLISTED],
      timeline: [],
      convertedOrderId: null,
      totalWeightKg: 0,
      linesWithoutWeight: 0,
    } as unknown as Lead;
    render(
      <LeadRecordView
        lead={lead}
        stages={[]}
        optionLists={OPTIONS}
        packagingRequired={false}
        party={null}
        canEdit={false}
        canConvert={false}
        transport={{} as never}
        onConverted={() => undefined}
        onOpenOrder={() => undefined}
        onError={() => undefined}
      />,
    );
    expect(screen.getByText('Antique Ivory')).toBeTruthy();
    expect(screen.queryByText('Ivory', { exact: true })).toBeNull();
    expect(screen.getByText('Sea Green')).toBeTruthy();
  });

  it('final-order detail (OrderRecordView)', () => {
    const order = {
      id: 'OR0000000001',
      partyId: 'PT0000000001',
      partyName: 'Patel Tiles',
      leadId: null,
      stageId: 's1',
      stageName: 'In Progress',
      stageSequence: 1,
      items: [LINE, UNLISTED],
      timeline: [],
      totalWeightKg: 0,
      totalWeightKgOverride: null,
      weightSource: 'computed',
      linesWithoutWeight: 0,
      dispatchedAt: null,
    } as unknown as Order;
    render(
      <OrderRecordView
        order={order}
        stages={[]}
        optionLists={OPTIONS}
        canEdit={false}
        canDispatch={false}
        transport={{ updateOrder: vi.fn(), setOrderStage: vi.fn(), dispatchOrder: vi.fn() }}
        onDispatched={() => undefined}
        onError={() => undefined}
      />,
    );
    expect(screen.getByText('Antique Ivory')).toBeTruthy();
    expect(screen.queryByText('Ivory', { exact: true })).toBeNull();
    expect(screen.getByText('Sea Green')).toBeTruthy();
  });
});
