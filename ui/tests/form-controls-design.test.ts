// @vitest-environment node
/**
 * UI redesign (2026-10-07), Buttons and Inputs artboards: the kit's button, field and toggle controls.
 * CSS cannot be run here, so each rule that carries a number from the artboard is pinned by its declaration.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const base = read('../src/base.css');

/** The declarations of the rule whose selector list is exactly `selector`. */
function rule(selector: string): string {
  const start = base.indexOf(`\n${selector} {`);
  expect(start, `no rule for ${selector}`).toBeGreaterThanOrEqual(0);
  return base.slice(start, base.indexOf('}', start));
}

describe('buttons', () => {
  it('are 14 px, weight 550, with a 1 px edge on every variant so a state never shifts the layout', () => {
    const block = rule('.ob-btn');
    expect(block).toContain('font-size: var(--t-body-size);');
    expect(block).toContain('font-weight: 550;');
    expect(block).toContain('border: 1px solid transparent;');
  });

  it('keep the primary edge on its own colour and darken both on hover and press', () => {
    expect(rule('.ob-btn--primary')).toContain('border-color: var(--accent);');
    const pressed = rule('.ob-btn--primary:hover:not(:disabled),\n.ob-btn--primary:active:not(:disabled)');
    expect(pressed).toContain('background: var(--accent-hover);');
    expect(pressed).toContain('border-color: var(--accent-hover);');
  });

  it('press one pixel down, and a danger press fills red', () => {
    expect(rule('.ob-btn:active:not(:disabled)')).toContain('transform: translateY(1px);');
    expect(rule('.ob-btn--danger:active:not(:disabled)')).toContain('background: var(--state-conflict);');
  });

  it('go flat grey when disabled, not dimmed, but a busy button keeps its look', () => {
    expect(base).not.toMatch(/\.ob-btn:disabled\s*\{\s*opacity/);
    const block = rule(".ob-btn--primary:disabled:not([aria-busy='true'])");
    expect(block).toContain('background: var(--bg-sunken);');
    expect(block).toContain('color: var(--fg-disabled);');
  });

  it('show the busy mark in place of the icon', () => {
    const source = read('../src/Button.tsx');
    expect(source).toMatch(/working \? \(\s*<BusyMark size=\{14\} label=""/);
  });
});

describe('icon buttons', () => {
  it('are 30 px squares with a 6 px radius, bordered, ghost or danger', () => {
    const block = rule('.ob-icon-btn');
    expect(block).toContain('width: var(--ctl-h-md);');
    expect(block).toContain('border-radius: var(--r-md);');
    expect(rule('.ob-icon-btn--bordered')).toContain('border-color: var(--line-control);');
    expect(rule('.ob-icon-btn--danger,\n.ob-icon-btn--danger:hover')).toContain('color: var(--state-conflict);');
  });
});

describe('fields', () => {
  it('are 14 px with 10 px side padding, and a focused one draws the 2 px ring offset by 2', () => {
    const block = rule('.ob-input,\n.ob-select,\n.ob-textarea');
    expect(block).toContain('font-size: var(--t-body-size);');
    expect(block).toContain('padding: 0 0.7143rem;');
    const focus = rule('.ob-input:focus,\n.ob-select:focus,\n.ob-textarea:focus');
    expect(focus).toContain('outline: 2px solid var(--line-focus);');
    expect(focus).toContain('outline-offset: 2px;');
  });

  it('darken their edge on hover from the rest colour, never lighten it', () => {
    expect(rule('.ob-input:hover,\n.ob-select:hover,\n.ob-textarea:hover')).toContain('border-color: var(--fg-tertiary);');
  });

  it('put the label above in the primary ink, weight 500, and quieten it with a disabled field', () => {
    const block = rule('.ob-label');
    expect(block).toContain('font-weight: 500;');
    expect(block).toContain('color: var(--fg-primary);');
    expect(rule('.ob-label:has(+ :disabled)')).toContain('color: var(--fg-disabled);');
  });

  it('say what failed with a red icon beside the text', () => {
    expect(rule('.ob-field-error')).toContain('display: flex;');
    expect(read('../src/Form.tsx')).toMatch(/className="ob-field-error"[\s\S]{0,120}<svg/);
  });
});

describe('checkbox, radio and switch', () => {
  it('draw a 3 px check and a 3 px dash on a 16 px box', () => {
    const source = read('../src/Form.tsx');
    expect(source).toContain('d="M6 12.5l4 4L18 8"');
    expect(source).toContain('d="M7 12h10"');
    expect(rule('.ob-checkbox-box')).toContain('width: 1.1429rem;');
  });

  it('fill a radio with a 5 px accent ring', () => {
    expect(rule('.ob-radio:checked')).toContain('border: 5px solid var(--accent);');
    expect(read('../src/Form.tsx')).toContain('export function Radio(');
  });

  it('are used for the role cards, not the browser radio', () => {
    expect(read('../src/RolePicker.tsx')).toMatch(/type="radio"[ \n]+className="ob-radio"/);
  });

  it('are a 32 x 18 switch with a 14 px thumb that travels 14 px, grey when off, with no border', () => {
    const block = rule('.ob-switch');
    expect(block).toContain('width: 2.2857rem;');
    expect(block).toContain('background: var(--line-strong);');
    expect(block).not.toContain('border:');
    expect(rule('.ob-switch::after')).toContain('width: 1rem;');
    expect(rule('.ob-check-row input:checked + .ob-switch::after')).toContain('translateX(1rem)');
  });
});
