/**
 * The screen that raises a new pending order is called "New Order" everywhere a person reads its
 * name (owner, 2026-10-07): the topbar button, the sidebar sub-page and the screen's title, the Basic
 * Home tile, the Ctrl+K command and the Save-all list. From 2026-10-08 the lists and the records are
 * "new orders" too: the words "pending order" are gone from the interface.
 */

import { describe, expect, it } from 'vitest';

import { COMMANDS, EN_MESSAGES } from '../src/index.js';

const en = EN_MESSAGES as Record<string, string>;

describe('the New Order name', () => {
  it('is the English text of the button, the title, the tile and the command', () => {
    expect(en['action.newLead']).toBe('New Order');
    expect(en['lead.add.title']).toBe('New Order');
    expect(en['basicHome.newLead']).toBe('New Order');
    expect(en['keys.command.new']).toBe('New Order');
  });

  it('names the unsaved draft in the Save-all list by it too', () => {
    expect(en['updates.saveAll.leadFor']).toBe('New Order for {party}');
    expect(en['updates.saveAll.newLead']).toBe('New Order (no party chosen yet)');
  });

  it('is what the Ctrl+Shift+N command is called, on both panels', () => {
    const command = COMMANDS.find((entry) => entry.id === 'record.new');
    expect(command).toBeDefined();
    expect(en[command!.titleToken]).toBe('New Order');
  });

  it('names the lists and the records New Orders too (owner, 2026-10-08)', () => {
    expect(en['nav.leads']).toBe('New Orders');
    expect(en['orderNote.pendingOrderNo']).toBe('New Order No.');
    // product.alteration.pendingOrders ('Pending orders') is the one legit survivor:
    // the alteration review distinguishes pending from frozen history.
    const left = Object.entries(en).filter(
      ([key, text]) => /pending order/i.test(text) && !key.startsWith('product.alteration.'),
    );
    expect(left).toEqual([]);
  });
});
