/**
 * Sorting and filters for the Parties and Products lists (1.4 D3, R17).
 *
 * `useStoredSort` remembers the chosen column and direction on this machine
 * (localStorage; blocked storage just means the choice lasts until the page
 * closes). The two filter rows are the controls the four list screens share, so
 * both panels offer the same ones: Products by size and photo (brand and
 * product have their own controls), Parties by city, state and GST number.
 */

import { useCallback, useState } from 'react';

import { Button } from './Button.js';
import type { DataTableSort } from './DataTable.js';
import { Input } from './Form.js';
import { t } from './i18n.js';
import { rem } from './rem.js';
import { Select } from './SuggestInput.js';

const PREFIX = 'ob.listSort.';

function readSort(key: string, fallback: DataTableSort): DataTableSort {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<DataTableSort> | null;
    if (typeof parsed?.key === 'string' && (parsed.dir === 'asc' || parsed.dir === 'desc')) {
      return { key: parsed.key, dir: parsed.dir };
    }
  } catch {
    // Unreadable or blocked storage: the default.
  }
  return fallback;
}

/** A table's sort, kept per machine under `storageKey`. */
export function useStoredSort(
  storageKey: string,
  fallback: DataTableSort,
): [DataTableSort, (next: DataTableSort) => void] {
  const [sort, setSort] = useState<DataTableSort>(() => readSort(storageKey, fallback));
  const update = useCallback(
    (next: DataTableSort) => {
      setSort(next);
      try {
        window.localStorage.setItem(PREFIX + storageKey, JSON.stringify(next));
      } catch {
        // Storage blocked: the choice lasts until the page closes.
      }
    },
    [storageKey],
  );
  return [sort, update];
}

export type PresenceFilter = 'any' | 'yes' | 'no';

/** The wire value of a yes/no filter: `undefined` when it is off. */
export function presenceOf(value: PresenceFilter): boolean | undefined {
  return value === 'yes' ? true : value === 'no' ? false : undefined;
}

const ROW_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--s-8)',
  flexWrap: 'wrap',
  marginBottom: 'var(--s-12)',
} as const;

function PresenceSelect({
  value,
  onChange,
  label,
  yes,
  no,
}: {
  value: PresenceFilter;
  onChange: (next: PresenceFilter) => void;
  label: string;
  yes: string;
  no: string;
}) {
  return (
    <div style={{ width: rem(180) }}>
      <Select
        value={value}
        onChange={(event) => onChange(event.target.value as PresenceFilter)}
        aria-label={label}
      >
        <option value="any">{label}</option>
        <option value="yes">{yes}</option>
        <option value="no">{no}</option>
      </Select>
    </div>
  );
}

export interface ProductListFilters {
  size: string;
  hasPhoto: PresenceFilter;
}

export const NO_PRODUCT_LIST_FILTERS: ProductListFilters = { size: '', hasPhoto: 'any' };

export function productFiltersActive(value: ProductListFilters): boolean {
  return value.size.trim() !== '' || value.hasPhoto !== 'any';
}

export function ProductFilterRow({
  value,
  onChange,
  extraActive = false,
  onClearAll,
}: {
  value: ProductListFilters;
  onChange: (next: ProductListFilters) => void;
  /** The screen's own search, brand chip or product select is on: Clear filters shows for them too. */
  extraActive?: boolean;
  /** Clears everything the screen filters by, this row's included; without it only this row resets. */
  onClearAll?: () => void;
}) {
  return (
    <div style={ROW_STYLE} data-testid="product-filter-row">
      <Input
        value={value.size}
        onChange={(event) => onChange({ ...value, size: event.target.value })}
        placeholder={t('listFilter.size')}
        aria-label={t('listFilter.size')}
        style={{ width: rem(160) }}
      />
      <PresenceSelect
        value={value.hasPhoto}
        onChange={(hasPhoto) => onChange({ ...value, hasPhoto })}
        label={t('listFilter.photo')}
        yes={t('listFilter.photo.yes')}
        no={t('listFilter.photo.no')}
      />
      {(productFiltersActive(value) || extraActive) && (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => (onClearAll ? onClearAll() : onChange(NO_PRODUCT_LIST_FILTERS))}
        >
          {t('listFilter.clear')}
        </Button>
      )}
    </div>
  );
}

export interface PartyListFilters {
  city: string;
  state: string;
  hasGst: PresenceFilter;
}

export const NO_PARTY_LIST_FILTERS: PartyListFilters = { city: '', state: '', hasGst: 'any' };

export function partyFiltersActive(value: PartyListFilters): boolean {
  return value.city.trim() !== '' || value.state.trim() !== '' || value.hasGst !== 'any';
}

export function PartyFilterRow({
  value,
  onChange,
  extraActive = false,
  onClearAll,
}: {
  value: PartyListFilters;
  onChange: (next: PartyListFilters) => void;
  /** The screen's own search or city chip is on: Clear filters shows for it too. */
  extraActive?: boolean;
  /** Clears everything the screen filters by, this row's included; without it only this row resets. */
  onClearAll?: () => void;
}) {
  return (
    <div style={ROW_STYLE} data-testid="party-filter-row">
      <Input
        value={value.city}
        onChange={(event) => onChange({ ...value, city: event.target.value })}
        placeholder={t('listFilter.city')}
        aria-label={t('listFilter.city')}
        style={{ width: rem(160) }}
      />
      <Input
        value={value.state}
        onChange={(event) => onChange({ ...value, state: event.target.value })}
        placeholder={t('listFilter.state')}
        aria-label={t('listFilter.state')}
        style={{ width: rem(160) }}
      />
      <PresenceSelect
        value={value.hasGst}
        onChange={(hasGst) => onChange({ ...value, hasGst })}
        label={t('listFilter.gst')}
        yes={t('listFilter.gst.yes')}
        no={t('listFilter.gst.no')}
      />
      {(partyFiltersActive(value) || extraActive) && (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => (onClearAll ? onClearAll() : onChange(NO_PARTY_LIST_FILTERS))}
        >
          {t('listFilter.clear')}
        </Button>
      )}
    </div>
  );
}
