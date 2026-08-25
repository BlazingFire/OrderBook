/**
 * Fields Management inputs (docs/LEAD_GENERATION_FLOW.md §3.1).
 *
 * A required custom field is marked, but it never blocks the save — the record
 * is stored and flagged incomplete instead. A panel that has been offline all
 * afternoon must not lose a lead because head office added a mandatory field
 * this morning.
 */

import type { CustomFieldDefinition } from '@orderbook/shared';

import { Checkbox, FormField, Input, Select } from '../ui/Form';

interface Props {
  definitions: CustomFieldDefinition[];
  values: Record<string, unknown>;
  onChange: (values: Record<string, unknown>) => void;
}

export function CustomFields({ definitions, values, onChange }: Props) {
  const active = definitions.filter((definition) => definition.isActive);
  if (active.length === 0) return null;

  function set(key: string, value: unknown): void {
    onChange({ ...values, [key]: value });
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--s-12) var(--s-16)' }}>
      {active.map((definition) => {
        const value = values[definition.key];

        return (
          <FormField key={definition.id} label={definition.label} required={definition.isRequired}>
            {(id) => {
              if (definition.fieldType === 'select') {
                return (
                  <Select id={id} value={String(value ?? '')} onChange={(event) => set(definition.key, event.target.value)}>
                    <option value="">—</option>
                    {definition.options.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </Select>
                );
              }

              if (definition.fieldType === 'boolean') {
                return (
                  <Checkbox checked={value === true} onChange={(checked) => set(definition.key, checked)} />
                );
              }

              // Every type is stored exactly as typed and left to the server's
              // normaliser to coerce. Parsing a number here would push the
              // parsed value back through a controlled input mid-entry, so a
              // leading "0" — the whole of "0", the start of "0.5" — is erased
              // before the rest of the figure arrives.
              return (
                <Input
                  id={id}
                  type={
                    definition.fieldType === 'number'
                      ? 'number'
                      : definition.fieldType === 'date'
                        ? 'date'
                        : 'text'
                  }
                  value={String(value ?? '')}
                  onChange={(event) => set(definition.key, event.target.value)}
                />
              );
            }}
          </FormField>
        );
      })}
    </div>
  );
}
