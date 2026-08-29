/**
 * A searchable dropdown over a set too large to render.
 *
 * A `<select>` is right for a closed enum, a curated option list or a
 * server-supplied facet — it is keyboard- and screen-reader-complete for free,
 * and replacing one with JavaScript is a downgrade. This is for the other case:
 * a party book or a product catalogue, where the answer is fetched as somebody
 * types and the list is never complete.
 *
 * What it owes the reader, and what each rule below is for:
 *
 *  · **The selection never disappears.** Whatever is chosen rides in `include`
 *    on every request, so typing a term that excludes it does not blank the
 *    field somebody is halfway through filling in.
 *  · **It says when it is not showing everything.** `truncated` renders a
 *    footer. A picker that silently shows the first twenty of two hundred
 *    teaches people that the thing they want is not there.
 *  · **It says when it is offline.** The Office panel answers from a cached
 *    page per collection when the Master is off, which is a different promise
 *    from "this is the catalogue".
 *  · **A stale response never wins.** Every fetch carries an `AbortController`
 *    and a resolved-but-aborted response is dropped, so the slow answer to
 *    "gl" cannot overwrite the fast answer to "glazed".
 *
 * Recents and pins live in `localStorage` — they are a property of the person
 * at the desk, not of the company — and pinned ids ride in `include` so they
 * are present in the idle state before anything has been typed.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

import { Input } from './Form';
import { t } from './i18n';
import { store } from './theme';
import { useDebounced } from './useDebounced';

/** How far PageUp/PageDown move. A screenful of a dense listbox. */
const PAGE_STEP = 8;

/** How many recent choices are remembered per picker. */
const RECENT_LIMIT = 5;

export interface PickerOption {
  id: string;
  label: string;
  /** The second line — a code, a city, whatever tells two rows apart. */
  hint?: string | null;
}

export interface PickerPage {
  items: PickerOption[];
  truncated: boolean;
  /** True when the answer came from a panel's cached snapshot, not the Master. */
  offline?: boolean;
}

function readIds(key: string): string[] {
  try {
    const raw = window.localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    // A private window, cleared site data, or something that is not JSON.
    // Recents are a convenience; losing them is not worth a failure.
    return [];
  }
}

export function Picker({
  value,
  onChange,
  fetchPage,
  label,
  placeholder,
  disabled,
  storageKey,
  onCreate,
  createLabel,
  emptyLabel,
}: {
  /** The chosen row, or null. Held by the caller — this component owns no selection. */
  value: PickerOption | null;
  onChange: (option: PickerOption | null) => void;
  /**
   * Fetch one page. `include` carries the ids that must come back whatever the
   * term matches; `signal` aborts when the term moves on or the picker closes.
   */
  fetchPage: (query: {
    term: string;
    include: string[];
    signal: AbortSignal;
  }) => Promise<PickerPage>;
  label: string;
  placeholder?: string;
  disabled?: boolean;
  /** Where recents and pins are remembered. Omit for a picker with no memory. */
  storageKey?: string;
  /** Ctrl+Enter, for "the party I want is not in the book yet". */
  onCreate?: (term: string) => void;
  createLabel?: string;
  emptyLabel?: string;
}) {
  const [term, setTerm] = useState('');
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<PickerPage>({ items: [], truncated: false });
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const [pinned, setPinned] = useState<string[]>(() =>
    storageKey ? readIds(`${storageKey}.pinned`) : [],
  );
  const [recent, setRecent] = useState<string[]>(() =>
    storageKey ? readIds(`${storageKey}.recent`) : [],
  );

  const inputRef = useRef<HTMLInputElement>(null);
  const settled = useDebounced(term);

  // The latest fetcher, without making it a dependency. See the effect below.
  const fetchPageRef = useRef(fetchPage);
  fetchPageRef.current = fetchPage;

  /*
   * Everything that must come back whatever the term matches: the current
   * selection, the pins, and the recents. Pins and recents are what make the
   * idle state useful — without them an unfilled picker opens on whatever the
   * catalogue happens to sort first.
   */
  const include = useMemo(() => {
    const ids = new Set<string>([...pinned, ...recent]);
    if (value) ids.add(value.id);
    return [...ids];
  }, [pinned, recent, value]);

  const includeKey = include.join(',');

  useEffect(() => {
    if (!open) return;

    const controller = new AbortController();
    setLoading(true);

    void fetchPageRef
      .current({ term: settled, include, signal: controller.signal })
      .then((next) => {
        // The slow answer to "gl" must not overwrite the fast answer to
        // "glazed".
        if (controller.signal.aborted) return;
        setPage(next);
        setActive(0);
        setLoading(false);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setPage({ items: [], truncated: false });
        setLoading(false);
      });

    return () => controller.abort();
    /*
     * Deliberately keyed on the term and the include *string*, not on
     * `fetchPage` or the `include` array. Both are fresh values on every render
     * at most call sites, so depending on them would refetch on every keystroke
     * of an unrelated field on the same form.
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, settled, includeKey, fetchPageRef]);

  /** Pinned first, then recent, then everything else in the server's order. */
  const ordered = useMemo(() => {
    const rank = (option: PickerOption): number => {
      if (pinned.includes(option.id)) return 0;
      if (recent.includes(option.id)) return 1;
      return 2;
    };

    return [...page.items].sort((a, b) => rank(a) - rank(b));
  }, [page.items, pinned, recent]);

  const remember = useCallback(
    (id: string) => {
      if (!storageKey) return;
      const next = [id, ...recent.filter((entry) => entry !== id)].slice(0, RECENT_LIMIT);
      setRecent(next);
      store(`${storageKey}.recent`, JSON.stringify(next));
    },
    [recent, storageKey],
  );

  const togglePin = useCallback(
    (id: string) => {
      if (!storageKey) return;
      const next = pinned.includes(id) ? pinned.filter((entry) => entry !== id) : [...pinned, id];
      setPinned(next);
      store(`${storageKey}.pinned`, JSON.stringify(next));
    },
    [pinned, storageKey],
  );

  const choose = useCallback(
    (option: PickerOption) => {
      onChange(option);
      remember(option.id);
      setTerm('');
      setOpen(false);
    },
    [onChange, remember],
  );

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    // Alt+↓ opens without moving the selection — the platform convention for
    // "show me the list".
    if (event.altKey && event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      return;
    }

    if (event.ctrlKey && event.key === 'Enter' && onCreate) {
      event.preventDefault();
      onCreate(term.trim());
      return;
    }

    if (event.ctrlKey && event.key.toLowerCase() === 'p') {
      const option = ordered[active];
      if (option) {
        event.preventDefault();
        togglePin(option.id);
      }
      return;
    }

    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'Enter') {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }

    const move = (delta: number): void => {
      event.preventDefault();
      setActive((current) => Math.max(0, Math.min(ordered.length - 1, current + delta)));
    };

    switch (event.key) {
      case 'ArrowDown':
        return move(1);
      case 'ArrowUp':
        return move(-1);
      case 'PageDown':
        return move(PAGE_STEP);
      case 'PageUp':
        return move(-PAGE_STEP);
      case 'Home':
        event.preventDefault();
        return setActive(0);
      case 'End':
        event.preventDefault();
        return setActive(Math.max(0, ordered.length - 1));

      case 'Enter': {
        const option = ordered[active];
        if (option) {
          event.preventDefault();
          choose(option);
        }
        return;
      }

      case 'Tab': {
        // Selects **and advances**. Tabbing out of a picker with a highlighted
        // row and having it discard the highlight is the single most annoying
        // thing a dropdown does; the caret is already on the answer.
        const option = ordered[active];
        if (option) choose(option);
        return;
      }

      case 'Escape': {
        // Closes first, clears second. One Escape should not throw away a
        // selection somebody only wanted to stop looking at.
        //
        // `preventDefault` only when one of those actually happened:
        // `useOverlay` reads it to decide whether the surrounding Modal closes,
        // so an empty picker that claimed Escape would strand the dialog.
        if (open) {
          event.preventDefault();
          setOpen(false);
        } else if (value) {
          event.preventDefault();
          onChange(null);
        }
        return;
      }

      default:
    }
  }

  const listboxId = `${label.replace(/\s+/g, '-').toLowerCase()}-listbox`;

  return (
    <div
      className="ob-picker"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <Input
        ref={inputRef}
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-label={label}
        disabled={disabled}
        placeholder={value ? value.label : placeholder}
        value={term}
        onChange={(event) => {
          setTerm(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />

      {open && (
        <div className="ob-picker-list" id={listboxId} role="listbox">
          {ordered.map((option, index) => (
            <button
              key={option.id}
              type="button"
              role="option"
              aria-selected={index === active}
              className="ob-picker-option"
              data-active={index === active || undefined}
              data-pinned={pinned.includes(option.id) || undefined}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(option)}
            >
              <span className="ob-picker-label">{option.label}</span>
              {option.hint && <span className="ob-picker-hint">{option.hint}</span>}
            </button>
          ))}

          {ordered.length === 0 && !loading && (
            <div className="ob-picker-note">{emptyLabel ?? t('picker.empty')}</div>
          )}

          <PickerFooter
            page={page}
            loading={loading}
            onCreate={onCreate}
            createLabel={createLabel}
          />
        </div>
      )}
    </div>
  );
}

/**
 * What the list is not showing, said out loud.
 *
 * Both notes matter and they are different facts: `truncated` means "there are
 * more, keep typing", while `offline` means "this is a cached page, not the
 * catalogue". Conflating them would tell somebody to keep typing for a row that
 * is not on this machine at all.
 */
function PickerFooter({
  page,
  loading,
  onCreate,
  createLabel,
}: {
  page: PickerPage;
  loading: boolean;
  onCreate?: (term: string) => void;
  createLabel?: string;
}): ReactNode {
  return (
    <div className="ob-picker-foot">
      {loading && <span className="ob-small">{t('picker.searching')}</span>}
      {!loading && page.truncated && <span className="ob-small">{t('picker.truncated')}</span>}
      {page.offline && <span className="ob-small ob-picker-offline">{t('picker.offline')}</span>}
      {onCreate && <span className="ob-small">{createLabel ?? t('picker.create')}</span>}
    </div>
  );
}
