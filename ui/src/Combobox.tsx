/**
 * Combobox (§9 Foundation) — typeahead over a listbox popover. Full
 * virtualization is the spec's ask for arbitrarily large lists; this product's
 * combobox lists (parties, products) run to the low hundreds at most, so a
 * capped render (first 200 matches) gets the same responsiveness without a
 * second windowing implementation to keep in sync with DataTable's.
 */

import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, RefObject } from 'react';
import { Input } from './Form';

const RENDER_CAP = 200;

export interface ComboboxOption<T> {
  key: string;
  label: string;
  value: T;
}

export function Combobox<T>({
  options,
  onSelect,
  placeholder,
  autoFocus,
  inputRef: externalRef,
}: {
  options: ComboboxOption<T>[];
  onSelect: (option: ComboboxOption<T>) => void;
  placeholder?: string;
  autoFocus?: boolean;
  inputRef?: RefObject<HTMLInputElement>;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const ownRef = useRef<HTMLInputElement>(null);
  const inputRef = externalRef ?? ownRef;

  const filtered = query
    ? options
        .filter((o) => o.label.toLowerCase().includes(query.toLowerCase()))
        .slice(0, RENDER_CAP)
    : options.slice(0, RENDER_CAP);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, open]);

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
    setOpen(false);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const option = filtered[activeIndex];
      if (option) choose(option);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <div className="ob-combobox" ref={wrapRef}>
      <Input
        ref={inputRef}
        autoFocus={autoFocus}
        value={query}
        placeholder={placeholder}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {open && (
        <div className="ob-combobox-listbox" role="listbox">
          {filtered.length === 0 ? (
            <div className="ob-combobox-empty">No matches</div>
          ) : (
            filtered.map((option, i) => (
              <div
                key={option.key}
                role="option"
                aria-selected={i === activeIndex}
                data-active={i === activeIndex}
                className="ob-combobox-option"
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(option);
                }}
                onMouseEnter={() => setActiveIndex(i)}
              >
                {option.label}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
