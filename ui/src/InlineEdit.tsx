/**
 * InlineEdit: rename in place. Text that becomes a field with the same metrics,
 * saves on Enter or blur, cancels on Escape, rolls back on failure.
 *
 * Controlled by the saved value: outside changes replace the text while not
 * editing. Return a promise from onSave for the saving state; reject to roll
 * back with the error shown inline.
 */

import { useEffect, useRef, useState } from 'react';

import { BusyMark } from './BusyMark.js';
import { t } from './i18n.js';

export function InlineEdit({
  value,
  onSave,
  label,
  validate,
  placeholder = '',
  multiline = false,
  variant = 'body',
  as: Tag = 'span',
}: {
  value: string;
  onSave: (next: string) => void | Promise<unknown>;
  label: string;
  validate?: (next: string) => string | null | undefined;
  placeholder?: string;
  multiline?: boolean;
  variant?: 'title' | 'body';
  as?: 'span' | 'p' | 'h1' | 'h2' | 'h3';
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const shown = useRef(value);
  shown.current = value;

  useEffect(() => {
    if (!editing) setDraft(shown.current);
  }, [value, editing]);

  const commit = (): void => {
    const next = draft.trim();
    const problem = validate?.(next);
    if (problem) {
      setError(problem);
      return;
    }
    if (next === value) {
      setEditing(false);
      setError(null);
      return;
    }
    setSaving(true);
    setError(null);
    void Promise.resolve()
      .then(() => onSave(next))
      .then(
        () => {
          setSaving(false);
          setEditing(false);
          setSaved(true);
          window.setTimeout(() => setSaved(false), 1200);
        },
        (caught: unknown) => {
          setSaving(false);
          setDraft(value);
          setError(caught instanceof Error ? caught.message : t('common.retry'));
        },
      );
  };

  if (!editing) {
    return (
      <span className={`ob-inline ob-inline--${variant}`}>
        <button
          type="button"
          className="ob-inline-text"
          aria-label={`${label}: ${value || placeholder}`}
          title={value || placeholder}
          onClick={() => {
            setDraft(value);
            setError(null);
            setEditing(true);
          }}
        >
          <Tag style={{ margin: 0, font: 'inherit' }}>{value || <span className="ob-inline-empty">{placeholder}</span>}</Tag>
        </button>
        {saved && (
          <span className="ob-inline-saved" role="status" aria-label={t('common.saved')}>
            ✓
          </span>
        )}
      </span>
    );
  }

  const field = multiline ? (
    <textarea
      autoFocus
      className="ob-input ob-inline-field"
      aria-label={label}
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? 'ob-inline-error' : undefined}
      value={draft}
      rows={Math.min(6, Math.max(2, draft.split('\n').length))}
      onChange={(event) => {
        setDraft(event.target.value);
        if (error) setError(null);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          setDraft(value);
          setError(null);
          setEditing(false);
        } else if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          commit();
        }
      }}
      onBlur={commit}
    />
  ) : (
    <input
      autoFocus
      className="ob-input ob-inline-field"
      aria-label={label}
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? 'ob-inline-error' : undefined}
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value);
        if (error) setError(null);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          setDraft(value);
          setError(null);
          setEditing(false);
        } else if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        }
      }}
      onBlur={commit}
    />
  );

  return (
    <span className={`ob-inline ob-inline--editing ob-inline--${variant}`}>
      {field}
      {saving ? (
        <BusyMark size={14} label="" />
      ) : (
        <>
          <button type="button" className="ob-inline-btn" aria-label={t('common.save')} onMouseDown={(event) => event.preventDefault()} onClick={commit}>
            ✓
          </button>
          <button
            type="button"
            className="ob-inline-btn"
            aria-label={t('common.cancel')}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              setDraft(value);
              setError(null);
              setEditing(false);
            }}
          >
            ✕
          </button>
        </>
      )}
      {error ? (
        <span id="ob-inline-error" className="ob-inline-error" role="alert">
          {error}
        </span>
      ) : null}
      <span className="ob-sr-only" role="status">
        {saving ? t('common.saving') : ''}
      </span>
    </span>
  );
}
