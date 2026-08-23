/**
 * Fields Management inputs (docs/LEAD_GENERATION_FLOW.md §3.1).
 *
 * A required custom field is marked, but it never blocks the save — the record
 * is stored and flagged incomplete instead. A panel that has been offline all
 * afternoon must not lose a lead because head office added a mandatory field
 * this morning.
 */

import type { CustomFieldDefinition } from '@orderbook/shared';

import { Field } from './Field';

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
    <div className="line-grid">
      {active.map((definition) => {
        const label = definition.isRequired ? `${definition.label} *` : definition.label;
        const value = values[definition.key];

        return (
          <Field key={definition.id} label={label}>
            {(id) => {
              if (definition.fieldType === 'select') {
                return (
                  <select
                    id={id}
                    value={String(value ?? '')}
                    onChange={(event) => set(definition.key, event.target.value)}
                  >
                    <option value="">—</option>
                    {definition.options.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                );
              }

              if (definition.fieldType === 'boolean') {
                return (
                  <input
                    id={id}
                    type="checkbox"
                    style={{ width: 'auto' }}
                    checked={value === true}
                    onChange={(event) => set(definition.key, event.target.checked)}
                  />
                );
              }

              return (
                <input
                  id={id}
                  type={
                    definition.fieldType === 'number'
                      ? 'number'
                      : definition.fieldType === 'date'
                        ? 'date'
                        : 'text'
                  }
                  value={String(value ?? '')}
                  onChange={(event) =>
                    set(
                      definition.key,
                      definition.fieldType === 'number'
                        ? Number(event.target.value) || null
                        : event.target.value,
                    )
                  }
                />
              );
            }}
          </Field>
        );
      })}
    </div>
  );
}
