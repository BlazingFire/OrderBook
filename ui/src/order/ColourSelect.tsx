/**
 * The colour cell of a multicolour row: a select that is also a type-to-filter box.
 *
 * Closed it shows the chosen colour (a dot and its name) or the placeholder, dashed amber until a
 * colour is chosen on a row that needs one. Open it lists the company's colours with their dots;
 * typing narrows the list, the arrows move, Enter picks and goes on, Escape closes. Not the kit's
 * `Combobox` (it takes the first row on any Enter) and not a native select (on Windows it commits a
 * value on every arrow press).
 *
 * Presentational: it owns only what is typed and whether the list is down. The screen owns the
 * value, the Enter walk (`onAdvance` is "the walk's next stop") and all strings.
 */

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type Ref,
} from 'react';

import type { OptionListItem } from '@orderbook/shared';

import { ColourChip } from '../DataDisplay.js';
import { Icon } from '../icons.js';
import { Input } from '../Form.js';
import './order.css';

export function ColourSelect({
  value,
  options,
  labelOf,
  hexOf,
  ariaLabel,
  placeholder,
  hint,
  filterHint,
  noMatches,
  attention = false,
  openOnEnter = true,
  inputRef,
  onPick,
  onAdvance,
}: {
  /** The chosen colour's list value; blank when none. */
  value: string;
  options: readonly OptionListItem[];
  /** A colour's current label from the list (a renamed colour reads by its new name). */
  labelOf: (value: string) => string;
  hexOf: (value: string) => string | undefined;
  ariaLabel: string;
  /** "Pick colour". */
  placeholder: string;
  /** Under the open list: "↑↓ move · Enter picks". */
  hint: string;
  /** The quiet first row of the open list: "Type to filter". Omitted: no such row. */
  filterHint?: string;
  noMatches: string;
  /** Draws the dashed amber "needs a colour" border while no colour is chosen. */
  attention?: boolean;
  /**
   * Enter on a closed select with no colour opens the list (default). False for a row nobody has
   * started (no quantity): Enter goes on to the walk's next stop instead, and the list opens on an
   * arrow, a click or typing.
   */
  openOnEnter?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  onPick: (value: string) => void;
  /**
   * The walk's next stop: after a pick (called with the colour just taken, before the row's own
   * state has caught up), on Enter over a closed select that has its colour, and on Enter over a
   * closed one of an unstarted row (`openOnEnter` false).
   */
  onAdvance: (picked?: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  /*
   * The list is placed against the window, not the cell: the grid's body scrolls, and an absolutely
   * placed list would be clipped by it on a row near the bottom. It opens below the box, or above it
   * when there is not room below.
   */
  const wrap = useRef<HTMLSpanElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<CSSProperties>({});
  useLayoutEffect(() => {
    if (!open || !wrap.current) return;
    const box = wrap.current.getBoundingClientRect();
    const room = window.innerHeight - box.bottom;
    const tall = 260;
    setPlace(
      room >= tall || room >= box.top
        ? { position: 'fixed', left: box.left, top: box.bottom + 6 }
        : { position: 'fixed', left: box.left, bottom: window.innerHeight - box.top + 6 },
    );
  }, [open, query]);

  const term = query.trim().toLowerCase();
  const matches = options.filter(
    (option) =>
      option.label.toLowerCase().includes(term) || option.value.toLowerCase().includes(term),
  );
  const pick = matches.length ? Math.min(sel, matches.length - 1) : 0;

  // The highlighted colour stays on screen as the arrows walk past the list's visible rows.
  // `?.()`: jsdom has no `scrollIntoView`.
  useEffect(() => {
    if (!open) return;
    const rows = listRef.current?.querySelectorAll<HTMLElement>('[role="option"]');
    rows?.[pick]?.scrollIntoView?.({ block: 'nearest' });
  }, [open, pick]);

  function take(colour: string): void {
    onPick(colour);
    setQuery('');
    setOpen(false);
    setSel(0);
    onAdvance(colour);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (open) setSel(Math.min(pick + 1, Math.max(0, matches.length - 1)));
      setOpen(true);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSel(Math.max(0, pick - 1));
      return;
    }
    if (event.key === 'Escape' && open) {
      // Closes the list only: the screen's Escape walk steps back on the next press.
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      return;
    }
    if (event.key !== 'Enter' || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) {
      return;
    }
    // Claimed: the screen's own walk must not also step on.
    event.preventDefault();
    event.stopPropagation();
    const chosen = open ? matches[pick] : undefined;
    if (chosen) take(chosen.value);
    else if (value || !openOnEnter) onAdvance();
    else setOpen(true);
  }

  const shown = open ? query : value ? labelOf(value) : '';

  return (
    <span
      ref={wrap}
      className="ob-order-colour"
      data-state={value ? 'set' : attention ? 'needed' : 'idle'}
    >
      <span className="ob-order-colour__dot" aria-hidden="true">
        {value ? (
          <ColourChip name={labelOf(value)} hex={hexOf(value)} />
        ) : (
          <span className="ob-order-colour__empty" />
        )}
      </span>
      <Input
        ref={inputRef}
        value={shown}
        placeholder={placeholder}
        aria-label={ariaLabel}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        className="ob-order-colour__input"
        onClick={() => setOpen(true)}
        onBlur={() => {
          setOpen(false);
          setQuery('');
        }}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
          setSel(0);
        }}
        onKeyDown={onKeyDown}
      />
      <Icon name="chevron-down" size={12} />
      {open && (
        <div
          ref={listRef}
          role="listbox"
          aria-label={ariaLabel}
          className="ob-order-colour__list"
          style={place}
        >
          {filterHint && <p className="ob-order-colour__filter">{filterHint}</p>}
          {matches.map((option, index) => (
            <button
              key={option.id}
              type="button"
              role="option"
              // Out of the Tab order: the box's blur closes the list.
              tabIndex={-1}
              aria-selected={index === pick}
              className="ob-order-colour__row"
              data-active={index === pick ? 'true' : undefined}
              onMouseEnter={() => setSel(index)}
              // `mousedown`, not `click`: the box's blur would close the list first.
              onMouseDown={(event) => {
                event.preventDefault();
                take(option.value);
              }}
            >
              <ColourChip name={option.label} hex={hexOf(option.value)} />
              <span>{option.label}</span>
            </button>
          ))}
          {matches.length === 0 && <p className="ob-order-colour__none">{noMatches}</p>}
          <p className="ob-order-colour__hint">{hint}</p>
        </div>
      )}
    </span>
  );
}
