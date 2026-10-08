import {
  Children,
  forwardRef,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
  type RefObject,
  type SelectHTMLAttributes,
} from 'react';

import { Input } from './Form.js';
import { rem } from './rem.js';

/**
 * Keep the highlighted row on screen as the arrows move it.
 *
 * `.ob-suggest` caps the list at 18rem and scrolls it, so on a twelve-category
 * list the fourth ArrowDown moved a highlight nobody could see any more. `block: 'nearest'` scrolls only when it has to, which is what
 * keeps the list still while the highlight is walking the visible rows.
 *
 * `?.()` because jsdom implements no layout and no `scrollIntoView` at all —
 * the component tests render this field, and an unguarded call would fail
 * them for a reason that has nothing to do with what they assert.
 */
function useHighlightInView(
  listRef: RefObject<HTMLDivElement | null>,
  highlighted: number,
  listOpen: boolean,
): void {
  useEffect(() => {
    if (!listOpen || highlighted < 0) return;
    const rows = listRef.current?.querySelectorAll<HTMLElement>('[role="option"]');
    rows?.[highlighted]?.scrollIntoView?.({ block: 'nearest' });
  }, [listRef, highlighted, listOpen]);
}

/** The field an `arriveAt` is focusing, for the length of that one `focus()` call. */
const arriving = new WeakSet<Element>();

/**
 * Focus a field as the Enter walk's arrival (owner, 2026-10-08): a pick list there — the colour,
 * a packaging or grade `Select` — opens at once, and its first Escape only closes it. A focus by
 * click, Tab or the Escape walk back is a plain focus. The focus event fires inside `focus()`, so
 * the field's own `onFocus` asks `isArriving` while the mark is still on.
 */
export function arriveAt(field: HTMLElement | null | undefined): void {
  if (!field) return;
  arriving.add(field);
  try {
    field.focus();
  } finally {
    arriving.delete(field);
  }
}

/** True inside the focus event an `arriveAt` caused. */
export function isArriving(field: EventTarget | null): boolean {
  return field instanceof Element && arriving.has(field);
}

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
  /**
   * Whether the person asked for this list, or it merely appeared under the
   * caret when the field took focus.
   *
   * Escape is claimed only for a list that was asked for. A list that opened
   * on focus is not something anybody is trying to get out of, and swallowing
   * the key there is what made Escape in the product dialog do nothing the
   * first time it was pressed — the list closed, invisibly, and the dialog
   * stayed.
   */
  const [summoned, setSummoned] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

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

  useHighlightInView(listRef, highlighted, listOpen);

  function commit(next: string): void {
    onChange(next);
    setOpen(false);
    setSummoned(false);
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
          setSummoned(true);
          setActive(0);
        }}
        onFocus={() => {
          setFiltering(true);
          setOpen(true);
        }}
        onBlur={() => {
          setOpen(false);
          setSummoned(false);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setSummoned(true);
            /*
             * The first press only opens the list.
             *
             * Moving the highlight in the same press would skip whatever is at
             * the top of a list that had not been showing.
             */
            if (!listOpen) {
              setOpen(true);
              return;
            }
            /*
             * Stepped from `highlighted`, not from `active`.
             *
             * `active` is the raw counter and `highlighted` is it clamped to
             * the rows that exist. Once a narrowed list had left the two apart
             * — type three letters after arrowing down a long list — the next
             * arrow moved `active` where nobody could see it and the highlight
             * sat still for several presses.
             *
             * And **no `setFiltering(true)` here**: flipping it re-narrowed a
             * list the chevron had opened in full, so the rows moved under the
             * highlight on the very press that was meant to walk them.
             */
            setActive(
              event.key === 'ArrowDown'
                ? Math.min(highlighted + 1, matches.length - 1)
                : Math.max(highlighted - 1, 0),
            );
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
            setOpen(false);
            // Claimed only for a list somebody asked for — see `summoned`. A
            // list that merely opened on focus closes and lets the key through
            // to the dialog or screen around it, which is where Escape means
            // something.
            if (summoned) event.preventDefault();
            setSummoned(false);
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
            setSummoned(true);
            setOpen((current) => !current);
          }}
        >
          ▾
        </button>
      )}

      {listOpen && (
        <div role="listbox" className="ob-suggest" ref={listRef}>
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

/**
 * The pick-only sibling of `SuggestInput`, wearing the `<select>` API so the
 * screens that already render `<Select value onChange><option>…</Select>` keep
 * working unchanged. Same field, same chevron, same list — the shop asked for
 * one dropdown, not a native picker beside a custom one.
 *
 * Typing filters the list; nothing off the list is ever emitted, and a blur
 * puts the chosen label back. `onChange` receives an object whose only real
 * property is `target.value` — every caller in the tree reads exactly that and
 * nothing else.
 */
export const Select = forwardRef<HTMLInputElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select(
    { value, defaultValue, onChange, children, className, style, disabled, ...rest },
    ref,
  ) {
    const options = optionsOf(children);
    const [inner, setInner] = useState(String(defaultValue ?? ''));
    const current = value === undefined ? inner : String(value);
    const chosen = options.find((option) => option.value === current);
    const label = chosen?.label ?? '';

    const [text, setText] = useState(label);
    const [open, setOpen] = useState(false);
    const [active, setActive] = useState(0);
    const [filtering, setFiltering] = useState(false);
    /** As in `SuggestInput`: a list opened on focus must not eat Escape. */
    const [summoned, setSummoned] = useState(false);
    const listRef = useRef<HTMLDivElement>(null);
    useEffect(() => setText(label), [label]);

    const term = text.trim().toLowerCase();
    const matches =
      filtering && term
        ? options.filter((option) => option.label.toLowerCase().includes(term))
        : options;
    const highlighted = matches.length > 0 ? Math.min(active, matches.length - 1) : -1;
    const listOpen = open && matches.length > 0;

    useHighlightInView(listRef, highlighted, listOpen);

    function commit(next: string): void {
      setOpen(false);
      setFiltering(false);
      setSummoned(false);
      if (next === current) {
        setText(label);
        return;
      }
      setInner(next);
      onChange?.({ target: { value: next } } as unknown as ChangeEvent<HTMLSelectElement>);
    }

    return (
      <span style={{ position: 'relative', display: 'block', ...style }}>
        <Input
          ref={ref}
          {...(rest as object)}
          className={className}
          value={text}
          disabled={disabled}
          // "None" chosen (the "—" option): a list may draw it quieter than a real value.
          data-empty={current === '' ? 'true' : undefined}
          autoComplete="off"
          role="combobox"
          aria-expanded={listOpen}
          aria-autocomplete="list"
          style={{ width: '100%', paddingRight: rem(28) }}
          onChange={(event) => {
            setText(event.target.value);
            setFiltering(true);
            setOpen(true);
            setSummoned(true);
            setActive(0);
          }}
          onFocus={(event) => {
            event.target.select();
            setFiltering(false);
            setActive(Math.max(0, options.findIndex((option) => option.value === current)));
            setOpen(true);
            // The walk brought the caret here: the list counts as asked for, so Escape closes it
            // before it walks back (`arriveAt`).
            setSummoned(isArriving(event.target));
          }}
          onBlur={() => {
            setOpen(false);
            setFiltering(false);
            setSummoned(false);
            setText(label);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              setSummoned(true);
              if (!listOpen) {
                setOpen(true);
                return;
              }
              // From `highlighted`, not `active` — see `SuggestInput`.
              setActive(
                event.key === 'ArrowDown'
                  ? Math.min(highlighted + 1, matches.length - 1)
                  : Math.max(highlighted - 1, 0),
              );
              return;
            }
            if (event.key === 'Enter' && listOpen) {
              // Not claimed, for the same reason as `SuggestInput`: the walk on
              // `document` steps to the next field on this very press.
              const pick = highlighted >= 0 ? matches[highlighted] : undefined;
              if (pick) commit(pick.value);
              return;
            }
            if (event.key === 'Escape' && listOpen) {
              setOpen(false);
              setText(label);
              if (summoned) event.preventDefault();
              setSummoned(false);
            }
          }}
        />
        {options.length > 0 && !disabled && (
          <button
            type="button"
            tabIndex={-1}
            // Mouse-only: keyboard users open the list with ArrowDown.
            aria-hidden="true"
            className="ob-suggest-toggle"
            onMouseDown={(event) => {
              event.preventDefault();
              setFiltering(false);
              setActive(0);
              setSummoned(true);
              setOpen((now) => !now);
            }}
          >
            ▾
          </button>
        )}
        {listOpen && (
          <div role="listbox" className="ob-suggest" ref={listRef}>
            {matches.map((option, index) => (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={option.value === current}
                className="ob-suggest-row"
                style={{
                  gridTemplateColumns: 'minmax(0, 1fr)',
                  background: index === highlighted ? 'var(--bg-selected)' : undefined,
                }}
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
  },
);

/** `<option value>label</option>` children, flattened, in order. */
function optionsOf(children: ReactNode): Array<{ value: string; label: string }> {
  const out: Array<{ value: string; label: string }> = [];
  Children.forEach(children, (child) => {
    if (!isValidElement<{ value?: unknown; children?: ReactNode }>(child)) return;
    if (child.type !== 'option') {
      out.push(...optionsOf(child.props.children));
      return;
    }
    const label = textOf(child.props.children);
    out.push({ value: String(child.props.value ?? label), label });
  });
  return out;
}

function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return '';
}
