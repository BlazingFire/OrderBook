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
import { FormField, Input, NumberInput, Select, Switch } from './Form.js';
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
              onChange={(event) => onChange({ x: Number(event.target.value) })}
            />
          )}
        </FormField>
        <FormField label={t('designer.field.y')}>
          {(id) => (
            <NumberInput
              id={id}
              value={element.y}
              onChange={(event) => onChange({ y: Number(event.target.value) })}
            />
          )}
        </FormField>
        <FormField label={t('designer.field.width')}>
          {(id) => (
            <NumberInput
              id={id}
              value={element.w}
              onChange={(event) => onChange({ w: Number(event.target.value) })}
            />
          )}
        </FormField>
        <FormField label={t('designer.field.height')}>
          {(id) => (
            <NumberInput
              id={id}
              value={element.h}
              onChange={(event) => onChange({ h: Number(event.target.value) })}
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
                  onChange={(event) => patchStyle({ size: Number(event.target.value) })}
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
                onChange={(event) => patchStyle({ maxChars: Number(event.target.value) })}
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
