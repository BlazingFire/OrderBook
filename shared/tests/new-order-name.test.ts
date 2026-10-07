/**
 * The screen that raises a new pending order is called "New Order" everywhere a person reads its
 * name (owner, 2026-10-07): the topbar button, the sidebar sub-page and the screen's title, the Basic
 * Home tile, the Ctrl+K command and the Save-all list. The lists and the records keep "pending order".
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

  it('leaves the pending order lists and records alone', () => {
    expect(en['nav.leads']).toBe('Pending Orders');
    expect(en['setting.leads.followUpDefaultDays.label']).toContain('new pending order');
  });
});
