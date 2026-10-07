/**
 * A stage pill takes its tone from the colour an administrator gave the stage (Fields,
 * Stages), so a "Cancelled" stage seeded red reads red, not the terminal green it used to.
 */

import { describe, expect, it } from 'vitest';

import { stageTone, toneForColour } from '../src/DataDisplay.js';

describe('toneForColour', () => {
  it('maps the seeded stage colours to the pill tones', () => {
    // 20260301000000_tenancy_access_and_sync.ts: LEAD_STAGES and ORDER_STAGES.
    expect(toneForColour('#5B8DEF')).toBe('accent'); // New, In Progress
    expect(toneForColour('#9B7BEF')).toBe('accent'); // Quoted
    expect(toneForColour('#EFA65B')).toBe('offline'); // Negotiating, Postpone: amber
    expect(toneForColour('#4CAF7D')).toBe('ok'); // Won, Dispatched
    expect(toneForColour('#C7576B')).toBe('conflict'); // Lost, Cancelled: red
  });

  it('reads #rgb, ignores case, calls greys neutral and anything else no colour', () => {
    expect(toneForColour('#c33')).toBe('conflict');
    expect(toneForColour('6e7c84')).toBe('default');
    expect(toneForColour('#FFFFFF')).toBe('default');
    expect(toneForColour('red')).toBeNull();
    expect(toneForColour('')).toBeNull();
    expect(toneForColour(null)).toBeNull();
  });
});

describe('stageTone', () => {
  const stage = (colour: string | null, isTerminal = false, isDefault = false) => ({
    colour,
    isTerminal,
    isDefault,
  });

  it('lets the stage colour win over the terminal flag', () => {
    expect(stageTone(stage('#C7576B', true))).toBe('conflict');
  });

  it('falls back to the flags only when the stage has no colour', () => {
    expect(stageTone(stage(null, true))).toBe('ok');
    expect(stageTone(stage(null, false, true))).toBe('accent');
    expect(stageTone(stage(null))).toBe('default');
    expect(stageTone(undefined)).toBe('default');
  });

  it('shows a dispatched order green whatever its stage colour', () => {
    expect(stageTone(stage('#EFA65B'), true)).toBe('ok');
  });
});
