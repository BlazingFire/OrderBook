/**
 * MultiPicker — choose several things from one searchable list.
 *
 * For "add several people": a single `Combobox` adds one item per pick, which is
 * slow when an administrator is handing a party to a team. This is a checklist
 * with a search box above it, the way a mail client picks recipients.
 *
 * Keyboard, all from the search box so focus never leaves it: type to filter,
 * Up/Down (and Home/End) move the highlight, Enter toggles the highlighted row,
 * Ctrl+A ticks everything shown. Escape clears a typed search first and, with
 * nothing typed, is left for the surrounding dialog (the same
 * `defaultPrevented` contract as `Combobox`). A row is also a click target.
 *
 * What the host receives is the set of selected keys, never the options: the
 * picker owns no domain knowledge.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { Button } from './Button.js';
import { Input } from './Form.js';
import { t } from './i18n.js';

export interface MultiPickerOption {
  key: string;
  /** The primary text; also what the search matches. */
  label: string;
  /** Secondary text (a role, a city); matched by the search too. */
  hint?: string;
  /** Leading decoration, such as an `Avatar`. */
  leading?: ReactNode;
}

export function MultiPicker({
  options,
  selected,
  onChange,
  ariaLabel,
  searchPlaceholder,
  emptyLabel,
  autoFocus,
}: {
  options: readonly MultiPickerOption[];
  selected: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  /** The list's accessible name. */
  ariaLabel: string;
  searchPlaceholder?: string;
  /** Shown when `options` itself is empty (not when a search matched nothing). */
  emptyLabel?: string;
  autoFocus?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter(
      (option) =>
        option.label.toLowerCase().includes(needle) || (option.hint ?? '').toLowerCase().includes(needle),
    );
  }, [options, query]);

  // A new search is a new list: start from its top.
  useEffect(() => setActive(0), [query]);
  // The highlight never points past the end after the list shrinks.
  const index = Math.min(active, Math.max(0, shown.length - 1));

  // Keep the highlighted row inside the scrolling list.
  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [index, shown]);

  function toggle(key: string): void {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange(next);
  }

  function setShown(on: boolean): void {
    const next = new Set(selected);
    for (const option of shown) {
      if (on) next.add(option.key);
      else next.delete(option.key);
    }
    onChange(next);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive(Math.min(index + 1, shown.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(Math.max(index - 1, 0));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActive(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setActive(Math.max(shown.length - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const option = shown[index];
      if (option) toggle(option.key);
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      setShown(true);
    } else if (event.key === 'Escape' && query !== '') {
      // Only claim the key when there is something to clear, or a dialog around
      // this would never close on Escape (see `useOverlay`).
      event.preventDefault();
      setQuery('');
    }
  }

  const everyShownSelected = shown.length > 0 && shown.every((option) => selected.has(option.key));

  return (
    <div className="ob-multipicker">
      <Input
        value={query}
        placeholder={searchPlaceholder}
        aria-label={searchPlaceholder ?? ariaLabel}
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={shown[index] ? `${listId}-${shown[index].key}` : undefined}
        autoFocus={autoFocus}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onKeyDown}
      />

      <div className="ob-multipicker-bar">
        <span className="ob-small" aria-live="polite">
          {t('multiPicker.selected', { count: selected.size })}
        </span>
        <span className="ob-multipicker-actions">
          <Button
            variant="ghost"
            size="sm"
            disabled={shown.length === 0 || everyShownSelected}
            onClick={() => setShown(true)}
          >
            {query.trim() ? t('multiPicker.selectShown') : t('multiPicker.selectAll')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={selected.size === 0}
            onClick={() => onChange(new Set())}
          >
            {t('multiPicker.clear')}
          </Button>
        </span>
      </div>

      <div
        id={listId}
        ref={listRef}
        className="ob-multipicker-list"
        role="listbox"
        aria-label={ariaLabel}
        aria-multiselectable="true"
      >
        {shown.length === 0 ? (
          <div className="ob-combobox-empty">
            {options.length === 0 ? (emptyLabel ?? t('common.noMatches')) : t('common.noMatches')}
          </div>
        ) : (
          shown.map((option, at) => {
            const on = selected.has(option.key);
            return (
              <div
                key={option.key}
                id={`${listId}-${option.key}`}
                role="option"
                aria-selected={on}
                data-active={at === index}
                className="ob-multipicker-row"
                title={option.hint ? `${option.label} · ${option.hint}` : option.label}
                // Keep the caret in the search box: the row is not a focus target.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => toggle(option.key)}
                onMouseEnter={() => setActive(at)}
              >
                <span className="ob-checkbox-box" aria-hidden="true" data-checked={on}>
                  {on ? (
                    <svg
                      width={10}
                      height={10}
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M3 8.5l3.2 3.2L13 4.5" />
                    </svg>
                  ) : null}
                </span>
                {option.leading}
                <span className="ob-multipicker-text">
                  <span className="ob-multipicker-label">{option.label}</span>
                  {option.hint ? <span className="ob-multipicker-hint">{option.hint}</span> : null}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
