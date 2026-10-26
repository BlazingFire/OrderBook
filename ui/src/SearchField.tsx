/**
 * SearchField + ExpandingSearch, built natively in the kit.
 *
 * SearchField: a controlled search input with a clear button that scales in
 * inside a reserved slot (field width never shifts), Escape clears, and the
 * input keeps `data-screen-search` so the `/` chord finds it. Debounce with
 * the existing `useDebounced` at the call site.
 *
 * ExpandingSearch: an icon button that morphs into a SearchField with grouped
 * local results beneath it. For crowded headers where a full field would take
 * the whole row.
 */

import { useEffect, useId, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { IconButton } from './Button.js';
import { t } from './i18n.js';
import { Popover } from './Popover.js';
import { useDebounced } from './useDebounced.js';

export function SearchField({
  label,
  value,
  onValueChange,
  placeholder,
  name,
  autoFocus,
}: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  name?: string;
  autoFocus?: boolean;
}) {
  return (
    <span className="ob-searchfield">
      <span className="ob-searchfield-icon" aria-hidden="true">
        <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
          <circle cx={11} cy={11} r={6} />
          <path d="M20 20l-4.5-4.5" />
        </svg>
      </span>
      <input
        type="search"
        className="ob-input ob-searchfield-input"
        aria-label={label}
        placeholder={placeholder ?? label}
        value={value}
        name={name}
        autoFocus={autoFocus}
        data-screen-search
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && value) {
            event.stopPropagation();
            onValueChange('');
          }
        }}
      />
      <span className="ob-searchfield-clear" data-on={value ? 'true' : undefined}>
        <IconButton
          icon="close"
          label={t('common.clearSearch')}
          size={14}
          tabIndex={value ? undefined : -1}
          aria-hidden={value ? undefined : true}
          onClick={() => onValueChange('')}
        />
      </span>
    </span>
  );
}

export interface ExpandingSearchItem {
  id: string;
  title: string;
  meta?: string;
  group?: string;
  keywords?: string[];
}

export function ExpandingSearch({
  label,
  items,
  suggestions = [],
  suggestionsLabel,
  placeholder,
  onSelect,
  onExpandedChange,
  expandedWidth = 360,
  maxResults = 6,
  emptyHint,
}: {
  label: string;
  items: ExpandingSearchItem[];
  suggestions?: ExpandingSearchItem[];
  suggestionsLabel?: string;
  placeholder?: string;
  onSelect?: (item: ExpandingSearchItem) => void;
  onExpandedChange?: (expanded: boolean) => void;
  expandedWidth?: number;
  maxResults?: number;
  anchor?: 'start' | 'end';
  emptyHint?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const settled = useDebounced(query.trim().toLowerCase(), 120);
  const boxId = useId();
  const listId = `${boxId}-results`;

  const ranked = useMemo(() => {
    if (!settled) return [];
    const scored = items
      .map((item) => {
        const hay = `${item.title} ${(item.keywords ?? []).join(' ')}`.toLowerCase();
        const at = hay.indexOf(settled);
        return at < 0 ? null : { item, score: at * 1000 + item.title.length };
      })
      .filter((entry): entry is { item: ExpandingSearchItem; score: number } => entry !== null)
      .sort((a, b) => a.score - b.score)
      .slice(0, maxResults)
      .map((entry) => entry.item);
    return scored;
  }, [items, settled, maxResults]);

  useEffect(() => setActive(0), [settled, open]);
  const showing = settled ? ranked : suggestions;
  const groups = useMemo(() => {
    const order: string[] = [];
    const byGroup = new Map<string, ExpandingSearchItem[]>();
    for (const item of showing) {
      const group = item.group ?? '';
      if (!byGroup.has(group)) {
        byGroup.set(group, []);
        order.push(group);
      }
      byGroup.get(group)!.push(item);
    }
    return order.map((group) => ({ group, items: byGroup.get(group)! }));
  }, [showing]);

  const expand = (next: boolean): void => {
    setOpen(next);
    if (!next) setQuery('');
    onExpandedChange?.(next);
  };

  const choose = (item: ExpandingSearchItem): void => {
    onSelect?.(item);
    expand(false);
  };

  if (!open) {
    return (
      <IconButton
        icon="search"
        label={label}
        aria-expanded={false}
        aria-controls={listId}
        onClick={() => expand(true)}
      />
    );
  }

  const flat = groups.flatMap((group) => group.items);
  return (
    <span className="ob-expsearch" style={{ width: `min(${expandedWidth}px, 100%)` }}>
      <span className="ob-searchfield" style={{ width: '100%' }}>
        <span className="ob-searchfield-icon" aria-hidden="true">
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
            <circle cx={11} cy={11} r={6} />
            <path d="M20 20l-4.5-4.5" />
          </svg>
        </span>
        <input
          autoFocus
          role="combobox"
          aria-expanded={flat.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={flat[active] ? `${boxId}-${flat[active]!.id}` : undefined}
          className="ob-input ob-searchfield-input"
          aria-label={label}
          placeholder={placeholder ?? label}
          value={query}
          data-screen-search
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              expand(false);
            } else if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActive((at) => (flat.length === 0 ? 0 : (at + 1) % flat.length));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActive((at) => (flat.length === 0 ? 0 : (at - 1 + flat.length) % flat.length));
            } else if (event.key === 'Enter' && flat[active]) {
              event.preventDefault();
              choose(flat[active]!);
            }
          }}
          onBlur={() => {
            // The results live in a popover beside the field; closing on blur
            // would eat the click. Close on Escape or selection instead.
          }}
        />
        <span className="ob-searchfield-clear" data-on="true">
          <IconButton icon="close" label={t('action.close')} size={14} onClick={() => expand(false)} />
        </span>
      </span>
      <Popover open={flat.length > 0 || settled !== ''} onClose={() => expand(false)}>
        <div role="listbox" id={listId} aria-label={label} className="ob-expsearch-results">
          {flat.length === 0 ? (
            <p className="ob-small" role="status">
              {settled ? (emptyHint ?? t('common.noMatches')) : (suggestionsLabel ?? t('common.suggestions'))}
            </p>
          ) : (
            groups.map(({ group, items: groupItems }) => (
              <div key={group || '-'} role="group" aria-label={group || undefined}>
                {group ? <p className="ob-eyebrow">{group}</p> : null}
                <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {groupItems.map((item) => {
                    const index = flat.indexOf(item);
                    return (
                      <li key={item.id} id={`${boxId}-${item.id}`} role="option" aria-selected={index === active}>
                        <button
                          type="button"
                          className="ob-expsearch-row"
                          data-active={index === active || undefined}
                          onMouseEnter={() => setActive(index)}
                          onClick={() => choose(item)}
                        >
                          <span className="ob-expsearch-title">{highlight(item.title, settled)}</span>
                          {item.meta ? <span className="ob-small">{item.meta}</span> : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))
          )}
        </div>
      </Popover>
      <span className="ob-sr-only" role="status">
        {settled ? t('common.resultsCount', { count: flat.length }) : ''}
      </span>
    </span>
  );
}

function highlight(title: string, query: string): ReactNode {
  if (!query) return title;
  const at = title.toLowerCase().indexOf(query);
  if (at < 0) return title;
  return (
    <>
      {title.slice(0, at)}
      <mark>{title.slice(at, at + query.length)}</mark>
      {title.slice(at + query.length)}
    </>
  );
}
