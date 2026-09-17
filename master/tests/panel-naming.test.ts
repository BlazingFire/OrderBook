/**
 * The next auto-paired panel's default name.
 *
 * `defaultPanelName` used to be `Office Panel ${count + 1}` over a count of
 * rows matching `Office Panel%`, and nothing enforces name uniqueness — only
 * `(tenant_id, device_code)` is unique, and renaming checks nothing. So: pair
 * two panels ("Office Panel 1", "Office Panel 2"), rename the first to
 * "Reception", and the count is 1 again, making the *next* panel "Office Panel
 * 2" as well. A duplicate name on the exact screen an administrator uses to
 * decide which panel to revoke, or which PC to walk to.
 *
 * Pure, so it cannot skip: only the repository read needs a database, and what
 * is worth pinning is the arithmetic.
 */

import { describe, expect, it } from 'vitest';

import { nextPanelName } from '../src/services/panel.service.js';

describe('nextPanelName', () => {
  it('starts at one', () => {
    expect(nextPanelName([])).toBe('Office Panel 1');
  });

  it('continues the sequence', () => {
    expect(nextPanelName(['Office Panel 1', 'Office Panel 2'])).toBe('Office Panel 3');
  });

  it('does not reuse a number after an earlier panel is renamed away', () => {
    /*
     * The defect, exactly.
     *
     * The repository filters on `Office Panel%`, so once "Office Panel 1" has
     * been renamed to "Reception" it is **not in this list at all** — which is
     * the whole trap. A count of what remains is 1, so the old rule answered
     * "Office Panel 2", the name the second panel already has.
     */
    expect(nextPanelName(['Office Panel 2'])).toBe('Office Panel 3');
  });

  it('takes the highest suffix, not the number of panels', () => {
    expect(nextPanelName(['Office Panel 7'])).toBe('Office Panel 8');
  });

  it('ignores a prefixed name whose tail is not a number', () => {
    // "Office Panel — Reception" matches the prefix and must not be able to
    // pull the sequence backwards or forwards.
    expect(nextPanelName(['Office Panel 3', 'Office Panel — Reception'])).toBe('Office Panel 4');
  });
});
