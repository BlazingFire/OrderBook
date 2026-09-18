/**
 * What date the New Lead form opens on.
 *
 * It opened on *today* — the one answer that is never a follow-up — because the
 * product had guessed on the shop's behalf. `leads.followUpDefaultDays` makes
 * it the owner's, and 0 keeps today expressible, which is what an installation
 * that never touches the setting gets.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { NewLeadScreen } from '../src/NewLeadScreen.js';
import type { NewLeadTransport } from '../src/NewLeadScreen.js';

afterEach(cleanup);

/** Answers nothing; this form renders its details fields before any of it resolves. */
const transport: NewLeadTransport = {
  pickParty: async () => [],
  pickCategory: async () => [],
  pickModels: async () => [],
  pickVariants: async () => [],
  optionLists: async () => [],
  variantsForParty: () => new Map(),
  partyWise: () => false,
  createLead: async () => ({ id: 'LD0000000001' }),
};

/** Local calendar date N days out, the same arithmetic the screen uses. */
function isoDate(daysFromToday: number): string {
  const now = new Date();
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysFromToday);
  const month = String(day.getMonth() + 1).padStart(2, '0');
  return `${day.getFullYear()}-${month}-${String(day.getDate()).padStart(2, '0')}`;
}

function renderWith(followUpDefaultDays: number) {
  render(
    <NewLeadScreen
      focusNonce={0}
      transport={transport}
      onSaved={() => {}}
      onCancel={() => {}}
      followUpDefaultDays={followUpDefaultDays}
      packagingRequired
    />,
  );
  return screen.getByLabelText('Follow up on') as HTMLInputElement;
}

describe('the follow-up date a new lead starts with', () => {
  it('opens on today at the shipped default of 0', () => {
    // The property an upgraded installation depends on, and the reason this
    // setting's floor is 0 rather than the 1 its neighbour uses.
    expect(renderWith(0).value).toBe(isoDate(0));
  });

  it("opens on the company's own number when it has set one", () => {
    expect(renderWith(3).value).toBe(isoDate(3));
  });

  it('follows the setting rather than the quick chips beside it', () => {
    // The chips are fixed at 1/3/7 and deliberately do not move with the
    // setting — they are shortcuts, not the default. A company set to 5 proves
    // the two are independent.
    expect(renderWith(5).value).toBe(isoDate(5));
  });
});
