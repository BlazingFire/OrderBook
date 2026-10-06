// @vitest-environment node
/**
 * U10 (2026-10-07): layout fixes found by a browser pass over the Chatroom, the Printroom and the note
 * screen at 1280×720, 1366×768, 1920×1080 and 3840×2160, at 100 % and 157 %, light and dark. CSS cannot be
 * run here, so each fix is pinned by the declaration that makes it, in the file that carries it.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const base = read('../src/base.css');
const note = read('../src/order-note.css');

/** The declarations of the rule whose selector list is exactly `selector`. */
function rule(css: string, selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, `no rule for ${selector}`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start));
}

describe('width: the same cap as the Dashboard, so nothing runs 3,600 px wide at 4K', () => {
  it.each(['.ob-chat-page', '.ob-chat-room', '.ob-print-page,\n.ob-print-detail'])('%s is capped at 114.286rem', (selector) => {
    expect(rule(base, selector)).toContain('max-width: 114.286rem;');
  });

  it('keeps a message line readable', () => {
    expect(rule(base, '.ob-chat-body')).toContain('max-width: 100ch;');
  });
});

describe('labels never wrap beside their field', () => {
  it('on the note toolbar and the Printroom station strip ("Vehicle no.", "Printer for this Printroom")', () => {
    const block = rule(note, '.ob-note-toolbar-item > span:first-child');
    expect(block).toContain('white-space: nowrap;');
    expect(block).toContain('flex: none;');
  });

  it('on the task form ("Due date")', () => {
    expect(rule(base, '.ob-chat-due > span')).toContain('white-space: nowrap;');
  });

  it('on a task row ("Mark done") and on the room header ("3 members")', () => {
    expect(rule(base, '.ob-chat-taskrow > .ob-check-row')).toContain('white-space: nowrap;');
    expect(rule(base, '.ob-chat-roomhead > .ob-small')).toContain('white-space: nowrap;');
    expect(rule(base, '.ob-chat-roomtitle')).toContain('min-width: 0;');
  });
});

describe('pickers open where they fit', () => {
  it('the person picker drops below its button and lines up with its right edge', () => {
    const source = read('../src/ChatroomScreen.tsx');
    expect(source).toMatch(/anchorStyle=\{\{ top: 'calc\(100% \+ var\(--s-4\)\)', right: 0 \}\}/);
  });

  it('the record picker in the composer opens upward, right-aligned', () => {
    const source = read('../src/ChatConversation.tsx');
    expect(source).toMatch(/anchorStyle=\{\{ bottom: 'calc\(100% \+ var\(--s-4\)\)', right: 0 \}\}/);
  });
});
