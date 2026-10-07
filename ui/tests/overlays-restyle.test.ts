import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, '../src/base.css'), 'utf8');
const src = (f: string) => readFileSync(resolve(__dirname, '../src', f), 'utf8');

describe('overlays restyle', () => {
  it('draws the scrim from the token', () => {
    expect(css).toMatch(/\.ob-overlay\s*\{[^}]*background:\s*var\(--overlay-scrim\)/);
  });
  it('the scrim is .32 and covers the whole window, not just the pane', () => {
    const tokens = readFileSync(resolve(__dirname, '../src/tokens.css'), 'utf8');
    expect(tokens).toMatch(/--overlay-scrim:\s*rgba\(16, 22, 26, 0\.32\)/);
    expect(css).toMatch(/\.ob-overlay\s*\{[^}]*position:\s*fixed/);
    expect(css).toMatch(/\.ob-modal-wrap\s*\{[^}]*position:\s*fixed/);
  });
  it('menu items keep a focus ring and have danger/separator/hint states', () => {
    expect(css).toMatch(/\.ob-menu-item:focus-visible\s*\{[^}]*2px solid var\(--line-focus\)/);
    for (const c of ['.ob-menu-item--danger', '.ob-menu-sep', '.ob-menu-hint']) expect(css).toContain(c);
  });
  it('the palette is a headerless modal with its own rows', () => {
    expect(src('Modal.tsx')).toContain("chrome === 'dialog'");
    expect(src('CommandPalette.tsx')).toContain('chrome="palette"');
    expect(css).toContain('.ob-palette-row');
  });
  it('the confirm body is secondary ink 10px under the title', () => {
    expect(src('ConfirmDialog.tsx')).toContain('ob-confirm-body');
    expect(css).toMatch(/\.ob-confirm-body\s*\{[^}]*color:\s*var\(--fg-secondary\)/);
    expect(css).toMatch(/:has\(> \.ob-confirm-body\)\s*\{[^}]*padding-top:\s*calc\(var\(--s-8\) \+ var\(--s-2\)\)/);
  });
  it('hand-rolled confirm modals cancel with ghost, not a bordered button', () => {
    for (const f of ['../../master/web/src/screens/FieldsScreen.tsx', '../../master/web/src/screens/PanelsScreen.tsx', '../../office/web/src/screens/MainProductsScreen.tsx', '../src/MainProductsScreen.tsx']) {
      const text = readFileSync(resolve(__dirname, f), 'utf8');
      expect(text).toMatch(/variant="ghost" onClick=\{\(\) => set(ConfirmRemove|ConfirmRevoke|Deleting)\(null\)\}/);
    }
  });
  it('confirm cancel is ghost', () => {
    expect(src('ConfirmDialog.tsx')).toMatch(/variant="ghost" onClick=\{onCancel\}/);
  });
  it('focus trap and Escape are still wired through useOverlay', () => {
    expect(src('Modal.tsx')).toContain('useOverlay');
  });
});
