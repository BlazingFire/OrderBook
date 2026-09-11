/**
 * What the selected element is, and everything about it that can be changed.
 *
 * Geometry in millimetres because that is what the layout stores and what a
 * ruler measures; type size in points because that is the unit a font size is
 * in and the one an operator has seen in every other program.
 *
 * The three controls the owner asked for by name live here: **size** is the
 * width and height boxes, **character limit** is `maxChars`, and **auto text
 * adjust** is the fit mode — wrap past the box, shrink to stay inside it,
 * truncate to one line, or clip to whole lines.
 */

import type {
  DocumentBindingRef,
  DocumentElement,
  ElementTextStyle,
  TextFit,
} from '@orderbook/shared';

import { Button } from './Button.js';
import { FormField, Input, NumberInput, Switch } from './Form.js';
import { Select } from './SuggestInput.js';
import { t } from './i18n.js';
import { rem } from './rem.js';

export interface BindingChoice {
  /** `catalogue:document.title`, or `custom:lead:siteName`. */
  value: string;
  label: string;
  group: string;
  ref: DocumentBindingRef;
}

export interface PageDesignerInspectorProps {
  element: DocumentElement | null;
  bindings: readonly BindingChoice[];
  onChange: (patch: Partial<DocumentElement>) => void;
  onDelete: () => void;
  onOrder: (move: 'front' | 'forward' | 'backward' | 'back') => void;
}

const FITS: readonly TextFit[] = ['wrap', 'shrink', 'truncate', 'clip'];

const bindingValue = (ref: DocumentBindingRef): string =>
  ref.source === 'catalogue' ? `catalogue:${ref.binding}` : `custom:${ref.entity}:${ref.key}`;

/**
 * A number box's value, or the value it already had.
 *
 * `Number('')` is 0, so clearing a width box to retype it used to snap the
 * element to zero width in the corner of the page before the first digit
 * arrived. Holding the current value until something parses keeps the box
 * usable without adding a draft-string-per-field.
 */
const num = (raw: string, fallback: number): number => {
  if (raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
};

/** `#RRGGBB` is what the server validates; an empty box means "no colour". */
const HEX = /^#[0-9A-Fa-f]{6}$/;
const hexOrNull = (raw: string): string | null => {
  const trimmed = raw.trim();
  return trimmed === '' || HEX.test(trimmed) ? (trimmed === '' ? null : trimmed) : null;
};
const hexIsValid = (raw: string): boolean => raw.trim() === '' || HEX.test(raw.trim());

export function PageDesignerInspector({
  element,
  bindings,
  onChange,
  onDelete,
  onOrder,
}: PageDesignerInspectorProps) {
  if (!element) {
    return (
      <p className="ob-small" style={{ padding: `0 ${rem(4)}` }}>
        {t('designer.inspector.empty')}
      </p>
    );
  }

  const style = 'style' in element ? element.style : null;

  const patchStyle = (patch: Partial<ElementTextStyle>): void => {
    if (!style) return;
    onChange({ style: { ...style, ...patch } } as Partial<DocumentElement>);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-12)' }}>
      <div className="ob-eyebrow">{t(`designer.kind.${element.kind}`)}</div>

      {/* --- Position and size, in millimetres ------------------------- */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--s-8)' }}>
        <FormField label={t('designer.field.x')}>
          {(id) => (
            <NumberInput
              id={id}
              value={element.x}
              onChange={(event) => onChange({ x: num(event.target.value, element.x) })}
            />
          )}
        </FormField>
        <FormField label={t('designer.field.y')}>
          {(id) => (
            <NumberInput
              id={id}
              value={element.y}
              onChange={(event) => onChange({ y: num(event.target.value, element.y) })}
            />
          )}
        </FormField>
        <FormField label={t('designer.field.width')}>
          {(id) => (
            <NumberInput
              id={id}
              value={element.w}
              onChange={(event) => onChange({ w: num(event.target.value, element.w) })}
            />
          )}
        </FormField>
        <FormField label={t('designer.field.height')}>
          {(id) => (
            <NumberInput
              id={id}
              value={element.h}
              onChange={(event) => onChange({ h: num(event.target.value, element.h) })}
            />
          )}
        </FormField>
      </div>

      {/* --- What it prints -------------------------------------------- */}
      {element.kind === 'text' && (
        <FormField label={t('designer.field.text')}>
          {(id) => (
            <Input
              id={id}
              value={element.text}
              onChange={(event) =>
                onChange({ text: event.target.value } as Partial<DocumentElement>)
              }
            />
          )}
        </FormField>
      )}

      {element.kind === 'field' && (
        <>
          <FormField label={t('designer.field.binding')}>
            {(id) => (
              <Select
                id={id}
                value={bindingValue(element.binding)}
                onChange={(event) => {
                  const choice = bindings.find((option) => option.value === event.target.value);
                  if (choice) onChange({ binding: choice.ref } as Partial<DocumentElement>);
                }}
              >
                {bindings.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {`${choice.group} · ${choice.label}`}
                  </option>
                ))}
              </Select>
            )}
          </FormField>

          <FormField label={t('designer.field.label')} hint={t('designer.field.labelHelp')}>
            {(id) => (
              <Input
                id={id}
                value={element.label ?? ''}
                onChange={(event) =>
                  onChange({
                    label: event.target.value.trim() ? event.target.value : null,
                    labelPlacement: event.target.value.trim() ? 'before' : 'none',
                  } as Partial<DocumentElement>)
                }
              />
            )}
          </FormField>
        </>
      )}

      {/* --- Typography, and the two the owner asked for by name -------- */}
      {style && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--s-8)' }}>
            <FormField label={t('designer.field.size')}>
              {(id) => (
                <NumberInput
                  id={id}
                  value={style.size}
                  onChange={(event) => patchStyle({ size: num(event.target.value, style.size) })}
                />
              )}
            </FormField>
            <FormField label={t('designer.field.face')}>
              {(id) => (
                <Select
                  id={id}
                  value={style.face}
                  onChange={(event) =>
                    patchStyle({ face: event.target.value as ElementTextStyle['face'] })
                  }
                >
                  <option value="body">{t('designer.face.body')}</option>
                  <option value="mono">{t('designer.face.mono')}</option>
                </Select>
              )}
            </FormField>
          </div>

          <FormField label={t('designer.field.align')}>
            {(id) => (
              <Select
                id={id}
                value={style.align}
                onChange={(event) =>
                  patchStyle({ align: event.target.value as ElementTextStyle['align'] })
                }
              >
                <option value="left">{t('designer.align.left')}</option>
                <option value="centre">{t('designer.align.centre')}</option>
                <option value="right">{t('designer.align.right')}</option>
              </Select>
            )}
          </FormField>

          <FormField label={t('designer.field.fit')} hint={t('designer.field.fitHelp')}>
            {(id) => (
              <Select
                id={id}
                value={style.fit}
                onChange={(event) => patchStyle({ fit: event.target.value as TextFit })}
              >
                {FITS.map((fit) => (
                  <option key={fit} value={fit}>
                    {t(`designer.fit.${fit}`)}
                  </option>
                ))}
              </Select>
            )}
          </FormField>

          <FormField label={t('designer.field.maxChars')} hint={t('designer.field.maxCharsHelp')}>
            {(id) => (
              <NumberInput
                id={id}
                value={style.maxChars}
                onChange={(event) => patchStyle({ maxChars: num(event.target.value, style.maxChars) })}
              />
            )}
          </FormField>

          {/* There was no way to set a colour anywhere in the designer, though
              `ElementTextStyle.colour`, `box.fill`, `box.stroke` and
              `rule.colour` are all typed, all validated as `#RRGGBB` and all
              drawn. A plain hex box, the same control the template's accent
              colour already uses — this codebase has no colour picker and does
              not need one for four fields. */}
          <FormField
            label={t('designer.field.colour')}
            hint={
              hexIsValid(style.colour ?? '')
                ? t('designer.field.colourHelp')
                : t('designer.field.colourInvalid')
            }
          >
            {(id) => (
              <Input
                id={id}
                value={style.colour ?? ''}
                placeholder="#1F2A3B"
                onChange={(event) => patchStyle({ colour: hexOrNull(event.target.value) })}
              />
            )}
          </FormField>

          <Switch
            label={t('designer.field.bold')}
            checked={style.bold}
            onChange={(bold) => patchStyle({ bold })}
          />
        </>
      )}

      {element.kind === 'box' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--s-8)' }}>
          <FormField label={t('designer.field.fill')}>
            {(id) => (
              <Input
                id={id}
                value={element.fill ?? ''}
                placeholder="#F3F4F6"
                onChange={(event) => onChange({ fill: hexOrNull(event.target.value) })}
              />
            )}
          </FormField>
          <FormField label={t('designer.field.stroke')}>
            {(id) => (
              <Input
                id={id}
                value={element.stroke ?? ''}
                placeholder="#DDDDDD"
                onChange={(event) => onChange({ stroke: hexOrNull(event.target.value) })}
              />
            )}
          </FormField>
          <FormField label={t('designer.field.radius')}>
            {(id) => (
              <NumberInput
                id={id}
                value={element.radius}
                onChange={(event) => onChange({ radius: num(event.target.value, element.radius) })}
              />
            )}
          </FormField>
        </div>
      )}

      {element.kind === 'rule' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--s-8)' }}>
          <FormField label={t('designer.field.colour')}>
            {(id) => (
              <Input
                id={id}
                value={element.colour ?? ''}
                placeholder="#DDDDDD"
                onChange={(event) => onChange({ colour: hexOrNull(event.target.value) })}
              />
            )}
          </FormField>
          <FormField label={t('designer.field.thickness')}>
            {(id) => (
              <NumberInput
                id={id}
                value={element.thickness}
                onChange={(event) =>
                  onChange({ thickness: num(event.target.value, element.thickness) })
                }
              />
            )}
          </FormField>
        </div>
      )}

      {/* An image element was created as a logo and stayed one: `slot` is
          stored and drawn but nothing could change it. */}
      {element.kind === 'image' && (
        <FormField label={t('designer.field.slot')}>
          {(id) => (
            <Select
              id={id}
              value={element.slot}
              onChange={(event) =>
                onChange({ slot: event.target.value as 'logo' | 'signature' })
              }
            >
              <option value="logo">{t('designer.slot.logo')}</option>
              <option value="signature">{t('designer.slot.signature')}</option>
            </Select>
          )}
        </FormField>
      )}

      {/* --- Whether it rides the table -------------------------------- */}
      {element.band === 'body' && element.kind !== 'table' && (
        <Switch
          label={t('designer.field.followsTable')}
          checked={element.flow === 'after-table'}
          onChange={(follows) =>
            onChange({ flow: follows ? 'after-table' : 'fixed' } as Partial<DocumentElement>)
          }
        />
      )}

      <FormField label={t('designer.field.band')} hint={t('designer.field.bandHelp')}>
        {(id) => (
          <Select
            id={id}
            value={element.band}
            onChange={(event) => onChange({ band: event.target.value as DocumentElement['band'] })}
          >
            <option value="header">{t('designer.band.header')}</option>
            <option value="body">{t('designer.band.body')}</option>
            <option value="footer">{t('designer.band.footer')}</option>
          </Select>
        )}
      </FormField>

      {/* --- Paint order and removal ----------------------------------- */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s-4)' }}>
        <Button variant="secondary" onClick={() => onOrder('front')}>
          {t('designer.order.front')}
        </Button>
        <Button variant="secondary" onClick={() => onOrder('forward')}>
          {t('designer.order.forward')}
        </Button>
        <Button variant="secondary" onClick={() => onOrder('backward')}>
          {t('designer.order.backward')}
        </Button>
        <Button variant="secondary" onClick={() => onOrder('back')}>
          {t('designer.order.back')}
        </Button>
      </div>

      {/* The one table cannot be removed: a layout without it is refused on
          save, and offering a button that leads to a refusal is a trap. */}
      {element.kind !== 'table' && (
        <Button variant="danger" onClick={onDelete}>
          {t('designer.remove')}
        </Button>
      )}
    </div>
  );
}
