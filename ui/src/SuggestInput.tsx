import { useState } from 'react';

import { Input } from './Form.js';
import { rem } from './rem.js';

/**
 * A field somebody can type into *or* pick from — the two halves of one
 * control rather than a `<select>` and a text box chosen between by whether the
 * company has filled its option list in.
 *
 * The shape the shop asked for: type "carto", the list narrows to Carton, Enter
 * takes it and moves on. A word that matches nothing is still a legal value —
 * `line.packaging` ships unseeded and a shop that has never filled it in has to
 * be able to type, so this never refuses what somebody wrote.
 *
 * **Enter is deliberately not claimed.** `useEnterToAdvance` listens on
 * `document`, after React's delegated handlers, and skips an event whose
 * `defaultPrevented` is set. So committing the highlighted suggestion and
 * letting the key through is what makes one press both choose the word and
 * step to the next field. Calling `preventDefault` here would select the word
 * and then sit still, which is the thing the walk exists to avoid.
 *
 * The shared `Combobox` is a different control and stayed unused on purpose: it
 * clears itself on select and emits only options, because it exists to *add* a
 * row to a list. This one edits a value and accepts one that is not on it.
 */
export function SuggestInput({
  id,
  value,
  options,
  onChange,
  invalid,
  placeholder,
  autoFocus,
  optionsLabel,
}: {
  /** So a `Field` label can point at the input. */
  id?: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (next: string) => void;
  invalid?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  /** Names the list for the chevron's screen-reader label. */
  optionsLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  /*
   * Whether the list is narrowed by what is in the field.
   *
   * False when the chevron opened it, so a field already holding "Carton" shows
   * every packaging rather than the one that matches itself — which is what
   * makes the dropdown half of this a dropdown.
   */
  const [filtering, setFiltering] = useState(true);

  const term = value.trim().toLowerCase();
  const matches =
    filtering && term
      ? options.filter(
          (option) =>
            option.label.toLowerCase().includes(term) || option.value.toLowerCase().includes(term),
        )
      : options;

  const highlighted = matches.length > 0 ? Math.min(active, matches.length - 1) : -1;
  const listOpen = open && matches.length > 0;

  function commit(next: string): void {
    onChange(next);
    setOpen(false);
  }

  return (
    <span style={{ position: 'relative', display: 'block', marginTop: rem(4) }}>
      <Input
        id={id}
        autoFocus={autoFocus}
        value={value}
        invalid={invalid}
        placeholder={placeholder}
        autoComplete="off"
        role="combobox"
        aria-expanded={listOpen}
        aria-autocomplete="list"
        style={{ width: '100%', paddingRight: rem(28) }}
        onChange={(event) => {
          onChange(event.target.value);
          setFiltering(true);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => {
          setFiltering(true);
          setOpen(true);
        }}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setFiltering(true);
            setOpen(true);
            setActive((current) => Math.min(current + 1, Math.max(0, matches.length - 1)));
            return;
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActive((current) => Math.max(0, current - 1));
            return;
          }
          if (event.key === 'Enter' && listOpen) {
            const chosen = highlighted >= 0 ? matches[highlighted] : undefined;
            // No `preventDefault` — see this component's header. The walk on
            // `document` runs next and moves to the following field, so one
            // press both takes the word and steps on. A press with nothing
            // highlighted keeps whatever was typed and advances just the same.
            if (chosen) commit(chosen.value);
            return;
          }
          if (event.key === 'Escape' && listOpen) {
            // Claimed only while there is a list to close, so a field that is
            // merely focused does not swallow the Escape a surrounding screen
            // uses to step backwards.
            event.preventDefault();
            setOpen(false);
          }
        }}
      />

      {options.length > 0 && (
        <button
          type="button"
          // Out of the Tab order: the field is the control, and the walk has its
          // own list. This is a mouse affordance saying "there is a list here".
          tabIndex={-1}
          aria-label={optionsLabel}
          className="ob-suggest-toggle"
          onMouseDown={(event) => {
            // Before the input's blur, so the toggle is a toggle rather than a
            // close-then-reopen.
            event.preventDefault();
            setFiltering(false);
            setActive(0);
            setOpen((current) => !current);
          }}
        >
          ▾
        </button>
      )}

      {listOpen && (
        <div role="listbox" className="ob-suggest">
          {matches.map((option, index) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={index === highlighted}
              className="ob-suggest-row"
              style={{
                gridTemplateColumns: 'minmax(0, 1fr)',
                background: index === highlighted ? 'var(--bg-selected)' : undefined,
              }}
              // `mousedown`, not `click`: the input's blur would close the list
              // out from under the pointer first.
              onMouseDown={(event) => {
                event.preventDefault();
                commit(option.value);
              }}
              onMouseEnter={() => setActive(index)}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
