// @vitest-environment node
/**
 * The record's notes are printed whole (CH1 / D10's audit, 2026-10-07): "don't cut what someone wrote". The last
 * page makes room for every line of them; a note too long for that gets pages of its own, so no sheet clips it.
 */

import { describe, expect, it } from 'vitest';

import {
  buildOrderNote,
  NOTE_LAYOUT,
  noteTextLines,
  notesBlockHeight,
  paginateOrderNote,
  splitNoteText,
  type LineItem,
  type NoteKind,
  type Order,
} from '../src/index.js';

let seq = 0;
function line(over: Partial<LineItem> = {}): LineItem {
  seq += 1;
  return {
    id: `l${seq}`, tenantId: 't', parentType: 'order', parentId: 'OD1', productId: `p${seq}`, variantId: `v${seq}`,
    productName: `Sub ${seq}`, categoryName: 'Duragres', categoryCode: 'DUR', brandName: null, alias: null, code: null,
    variantLabel: 'Ivory', colour: null, size: '600x600', weightKg: 2, packaging: 'Box', grade: 'Std', sequence: seq,
    fromPartyVariant: false, imagePath: null, notes: null, quantity: 3, lineWeightKg: 6, createdAt: '', updatedAt: '',
    ...over,
  } as LineItem;
}

function model(named: number, coded: number) {
  const items: LineItem[] = [];
  for (let i = 0; i < named; i += 1) items.push(line({ productName: `Model ${String(i).padStart(4, '0')}` }));
  for (let i = 0; i < coded; i += 1) items.push(line({ productName: String(100 + i), categoryName: `Group ${i % 5}` }));
  return buildOrderNote({ id: 'OD0000000001', items, totalWeightKg: 0, totalWeightKgOverride: null, weightSource: 'computed' } as unknown as Order);
}

/** A note of `words` distinct words, so a dropped or repeated one shows. */
const note = (words: number): string => Array.from({ length: words }, (_, i) => `word${i}`).join(' ');
const wordsOf = (text: string): string[] => text.split(' ').filter(Boolean);

describe.each(['filling', 'dispatch'] as const)('the notes of a %s note', (kind: NoteKind) => {
  it('keep the room they always had when they are short or empty', () => {
    for (const text of [null, '', 'Handle with care']) {
      const pages = paginateOrderNote(model(10, 20), kind, { notes: text });
      expect(pages.at(-1)!.notesHeight).toBe(NOTE_LAYOUT.notes);
      expect(pages.slice(0, -1).every((page) => page.notesHeight === 0)).toBe(true);
    }
  });

  it('make the last page as tall as the whole note needs, on the same pages as a short one', () => {
    const long = note(150);
    const short = paginateOrderNote(model(40, 120), kind, { notes: 'x' });
    const grown = paginateOrderNote(model(40, 120), kind, { notes: long });

    const last = grown.at(-1)!;
    expect(last.notesText).toBe(long);
    expect(last.notesHeight).toBe(notesBlockHeight(noteTextLines(long)));
    expect(last.notesHeight).toBeGreaterThan(NOTE_LAYOUT.notes);
    // Every line of the order is still printed once.
    expect(grown.reduce((sum, page) => sum + page.leftCount + page.rightCount, 0)).toBe(160);
    expect(grown.length).toBeGreaterThanOrEqual(short.length);
  });

  it('take their room from the lines: a page as full as it can be with a short note needs another with a long one', () => {
    const pageCount = (coded: number, text: string): number => paginateOrderNote(model(0, coded), kind, { notes: text }).length;
    let fullest = 0;
    for (let coded = 1; coded <= 700; coded += 1) {
      if (pageCount(coded, 'x') === 1) fullest = coded;
      else break;
    }
    expect(fullest).toBeGreaterThan(50);
    expect(noteTextLines(note(100))).toBeLessThanOrEqual(NOTE_LAYOUT.notesMaxLines);
    expect(pageCount(fullest, note(100))).toBeGreaterThan(1);
  });

  it('go onto pages of their own when they are too long for the last page, every word once and in order', () => {
    const text = note(2200);
    expect(noteTextLines(text)).toBeGreaterThan(NOTE_LAYOUT.notesMaxLines);
    const pages = paginateOrderNote(model(30, 60), kind, { notes: text });

    const withNotes = pages.filter((page) => page.notesHeight > 0);
    expect(withNotes.length).toBeGreaterThan(1);
    expect(withNotes.every((page) => page.leftCount === 0 && page.rightCount === 0)).toBe(true);
    expect(pages.at(-1)!.isLast).toBe(true);
    expect(withNotes.at(-1)).toBe(pages.at(-1));
    expect(wordsOf(withNotes.map((page) => page.notesText).join(' '))).toEqual(wordsOf(text));
    // The order's lines are all on the pages before them.
    expect(pages.reduce((sum, page) => sum + page.leftCount + page.rightCount, 0)).toBe(90);
    // No page is asked to hold more than it can.
    const room = 1123 - 46 - NOTE_LAYOUT.headerContDispatch - 8;
    for (const page of withNotes) expect(page.notesHeight).toBeLessThanOrEqual(room - NOTE_LAYOUT.signature);
  });

  it('keep their line breaks', () => {
    const pages = paginateOrderNote(model(5, 5), kind, { notes: 'one\ntwo\n\nthree' });
    expect(pages.at(-1)!.notesText).toBe('one\ntwo\n\nthree');
    expect(noteTextLines('one\ntwo\n\nthree')).toBe(4);
  });
});

describe('splitNoteText', () => {
  it('cuts at spaces and line ends, drops nothing, and keeps every part within its lines', () => {
    const text = `${note(900)}\nsecond paragraph here\n${note(300)}`;
    const parts = splitNoteText(text, 20);

    expect(parts.length).toBeGreaterThan(2);
    for (const part of parts) expect(noteTextLines(part)).toBeLessThanOrEqual(20);
    expect(wordsOf(parts.join(' ').replace(/\n/g, ' '))).toEqual(wordsOf(text.replace(/\n/g, ' ')));
  });
});
