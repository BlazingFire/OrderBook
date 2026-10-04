/**
 * Combobox (§9 Foundation) — typeahead over a listbox popover. Full
 * virtualization is the spec's ask for arbitrarily large lists; this product's
 * combobox lists (parties, products) run to the low hundreds at most, so a
 * capped render (first 200 matches) gets the same responsiveness without a
 * second windowing implementation to keep in sync with DataTable's.
 *
 * Keyboard (all from the field, so focus never leaves it): type to filter,
 * Up/Down/Home/End/PageUp/PageDown move the highlight and keep it in view, Enter
 * picks the highlighted row, Escape closes the list and — only when there was a
 * list to close — claims the key, so a surrounding dialog closes on the *next*
 * Escape and not the same one (`useOverlay` reads `defaultPrevented`). Tab or a
 * click elsewhere closes the list.
 *
 * Placement: the list opens below the field, or above it when that side has more
 * room, and is never taller than the room it has inside whatever would clip it
 * (a dialog body, the window). See `comboboxPlacement.ts`.
 *
 * Asynchronous lists: pass `filter={false}` and `onQueryChange`, and hand in the
 * options the query matched (with `loading` while they are on their way).
 */

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, ReactNode, RefObject } from 'react';
import { Input } from './Form';
import { clippingSpan, placeListbox, type ListboxPlacement } from './comboboxPlacement.js';
import { t } from './i18n.js';

const RENDER_CAP = 200;
/** The CSS's own ceiling for the list, in rem (`max-height` in `base.css`). */
const WANTED_REM = 17.1429;
const PAGE = 8;

export interface ComboboxOption<T> {
  key: string;
  label: string;
  value: T;
  /** Secondary text (a role, a city), shown after the label and matched by the filter. */
  hint?: string;
  /** Leading decoration, such as an `Avatar`. */
  leading?: ReactNode;
}

export function Combobox<T>({
  options,
  onSelect,
  placeholder,
  autoFocus,
  inputRef: externalRef,
  ariaLabel,
  emptyLabel,
  loading,
  filter = true,
  onQueryChange,
  disabled,
  quietFocusRef,
}: {
  options: ComboboxOption<T>[];
  onSelect: (option: ComboboxOption<T>) => void;
  placeholder?: string;
  autoFocus?: boolean;
  /** `| null` — see the note in `useOverlay.ts`. */
  inputRef?: RefObject<HTMLInputElement | null>;
  /** The field's accessible name. A placeholder is not one. */
  ariaLabel?: string;
  /** Shown when there is nothing to offer at all ("Everyone is already assigned"), as opposed to nothing matching. */
  emptyLabel?: string;
  /** The host is fetching options for the query. */
  loading?: boolean;
  /** False when `options` already match the query (the host searched). */
  filter?: boolean;
  /** Every change of the typed text, for a host that searches. */
  onQueryChange?: (query: string) => void;
  disabled?: boolean;
  /** Set true just before focusing the field from code: that one focus does not open the list. */
  quietFocusRef?: RefObject<boolean>;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [placement, setPlacement] = useState<ListboxPlacement>({ side: 'below', room: null });
  const wrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const ownRef = useRef<HTMLInputElement>(null);
  const inputRef = externalRef ?? ownRef;
  // Scrolling the highlight into view is for the keyboard: a hover moving it would make the list jitter under the pointer.
  const keyboardMove = useRef(false);
  const id = useId();

  const needle = query.trim().toLowerCase();
  const matches =
    filter && needle
      ? options.filter(
          (o) =>
            o.label.toLowerCase().includes(needle) || (o.hint ?? '').toLowerCase().includes(needle),
        )
      : options;
  const filtered = matches.slice(0, RENDER_CAP);
  const last = Math.max(filtered.length - 1, 0);
  const active = Math.min(activeIndex, last);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, open]);

  // Where the list goes, measured when it opens and whenever its content or the window changes.
  useLayoutEffect(() => {
    if (!open || !wrapRef.current) return;
    const wrap = wrapRef.current;
    const measure = (): void => {
      const field = wrap.getBoundingClientRect();
      const rootPx = parseFloat(getComputedStyle(wrap.ownerDocument.documentElement).fontSize) || 14;
      const next = placeListbox(field, clippingSpan(wrap), WANTED_REM * rootPx);
      setPlacement((current) =>
        current.side === next.side && current.room === next.room ? current : next,
      );
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open, filtered.length, loading]);

  useEffect(() => {
    if (!open || !keyboardMove.current) return;
    keyboardMove.current = false;
    listRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [active, open]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  function choose(option: ComboboxOption<T>) {
    onSelect(option);
    setQuery('');
    onQueryChange?.('');
    setOpen(false);
    // The pick happened without the field losing focus; say so for the browsers and hosts where it did.
    inputRef.current?.focus();
  }

  function move(to: number) {
    keyboardMove.current = true;
    setActiveIndex(Math.max(0, Math.min(to, last)));
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      // Opening is not moving: the first ArrowDown on a closed list shows it, from its first row.
      if (!open) setOpen(true);
      else move(active + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) setOpen(true);
      else move(active - 1);
    } else if (e.key === 'Home' && open) {
      e.preventDefault();
      move(0);
    } else if (e.key === 'End' && open) {
      e.preventDefault();
      move(last);
    } else if (e.key === 'PageDown' && open) {
      e.preventDefault();
      move(active + PAGE);
    } else if (e.key === 'PageUp' && open) {
      e.preventDefault();
      move(active - PAGE);
    } else if (e.key === 'Enter') {
      // Only a list that is showing can be picked from. A closed list used to choose its first
      // row on Enter, after an Escape had just dismissed it.
      const option = open ? filtered[active] : undefined;
      if (option) {
        e.preventDefault();
        choose(option);
      }
    } else if (e.key === 'Escape' && open) {
      // Claim the key only when there is a list to close. `useOverlay` reads
      // `defaultPrevented` to decide whether the surrounding Modal should also
      // close, so an unconditional `preventDefault` here would make a combobox
      // that is merely focused swallow every Escape in the dialog.
      e.preventDefault();
      setOpen(false);
    }
  }

  const listId = `${id}-list`;
  const optionId = (index: number) => `${id}-opt-${index}`;
  const nothingToOffer = options.length === 0 && !loading;

  return (
    <div
      className="ob-combobox"
      ref={wrapRef}
      onBlur={(event) => {
        // Tab (or anything else that moves focus out) closes the list; a click inside does not,
        // because the options take the mouse without taking focus.
        if (!wrapRef.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <Input
        ref={inputRef}
        autoFocus={autoFocus}
        disabled={disabled}
        value={query}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && filtered[active] ? optionId(active) : undefined}
        onChange={(e) => {
          setQuery(e.target.value);
          onQueryChange?.(e.target.value);
          setOpen(true);
        }}
        onFocus={() => {
          if (quietFocusRef?.current) quietFocusRef.current = false;
          else setOpen(true);
        }}
        onKeyDown={onKeyDown}
      />
      {open && (
        <div
          id={listId}
          ref={listRef}
          className={
            placement.side === 'above'
              ? 'ob-combobox-listbox ob-combobox-listbox--above'
              : 'ob-combobox-listbox'
          }
          style={
            placement.room === null
              ? undefined
              : ({ '--ob-combobox-room': `${Math.floor(placement.room)}px` } as CSSProperties)
          }
          role="listbox"
          aria-label={ariaLabel ?? placeholder}
        >
          {loading && filtered.length === 0 ? (
            <div className="ob-combobox-empty">{t('common.searching')}</div>
          ) : filtered.length === 0 ? (
            <div className="ob-combobox-empty">
              {nothingToOffer && emptyLabel ? emptyLabel : t('common.noMatches')}
            </div>
          ) : (
            <>
              {filtered.map((option, i) => (
                <div
                  key={option.key}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === active}
                  data-active={i === active}
                  className="ob-combobox-option"
                  title={option.hint ? `${option.label} · ${option.hint}` : option.label}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(option);
                  }}
                  onMouseEnter={() => setActiveIndex(i)}
                >
                  {option.leading}
                  <span className="ob-combobox-label">{option.label}</span>
                  {option.hint ? <span className="ob-combobox-hint">{option.hint}</span> : null}
                </div>
              ))}
              {matches.length > RENDER_CAP ? (
                <div className="ob-combobox-more">{t('common.refineSearch', { count: RENDER_CAP })}</div>
              ) : null}
            </>
          )}
        </div>
      )}
    </div>
  );
}
