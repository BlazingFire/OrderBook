/**
 * "Save to .txt" for the screens that show a value once: the first-run credentials, a password
 * reset, an API token, the pairing password. The values are written to a text file on this device
 * (a Blob and a download link, no dependency, nothing sent anywhere) so a person who is not at a
 * desk with a pen does not lose them.
 *
 * What the file says is decided here, once, so every screen's file reads the same: what it is, when it
 * was saved, which application and device, then the values under their own headings. Every word of it
 * comes from the message catalogue (`saveText.*`); the labels of the values are the screen's own.
 */

import { useState } from 'react';

import { uiConfig } from './config.js';
import { Button, type ButtonSize, type ButtonVariant } from './Button.js';
import { t } from './i18n.js';
import { saveBlob } from './ImportDialog.js';

export interface SavedValue {
  label: string;
  value: string;
}

export interface SavedSection {
  /** Printed above the values; omit for a single unnamed list. */
  heading?: string;
  values: readonly SavedValue[];
}

/** Where this is running, in words a person recognises: the address bar's host and the browser's platform. */
export function deviceDescription(): string {
  const host = typeof window !== 'undefined' ? window.location.host : '';
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  const platform = nav?.platform?.trim() ?? '';
  return [host, platform].filter(Boolean).join(' · ') || '—';
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** `2026-10-05 14:32`, in this device's local time. */
export function localStamp(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A name that is safe on every file system: `orderbook-first-run-2026-10-05.txt`. */
export function savedFileName(slug: string, date: Date): string {
  const safe = slug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'setup';
  return `orderbook-${safe}-${localStamp(date).slice(0, 10)}.txt`;
}

/**
 * The text of the file. Pure, so a test can read exactly what a person would find in it.
 * Windows Notepad is the expected reader, so lines end in CRLF.
 */
export function buildSavedText(input: {
  title: string;
  sections: readonly SavedSection[];
  /** The panel this runs in; defaults to this app's own. */
  app?: string;
  device?: string;
  now?: Date;
}): string {
  const app = input.app ?? (uiConfig().panel === 'office' ? t('saveText.app.office') : t('saveText.app.master'));
  const lines: string[] = [
    `${t('saveText.file.heading')} — ${input.title}`,
    '',
    `${t('saveText.file.saved')}: ${localStamp(input.now ?? new Date())}`,
    `${t('saveText.file.application')}: ${app}`,
    `${t('saveText.file.device')}: ${input.device ?? deviceDescription()}`,
  ];
  for (const section of input.sections) {
    if (section.values.length === 0) continue;
    lines.push('');
    if (section.heading) lines.push(section.heading, '-'.repeat(Math.min(section.heading.length, 40)));
    for (const { label, value } of section.values) lines.push(`${label}: ${value}`);
  }
  lines.push('', t('saveText.file.keepPrivate'));
  return lines.join('\r\n') + '\r\n';
}

/** Hands `text` to the browser as a download. */
export function downloadTextFile(fileName: string, text: string): void {
  // The BOM makes Notepad read it as UTF-8 whatever the PC's code page is.
  saveBlob(new Blob(['﻿', text], { type: 'text/plain;charset=utf-8' }), fileName);
}

interface SaveTextButtonProps {
  /** What the file is about, for its heading ("First-run details"). */
  title: string;
  /** Part of the file name: `first-run`, `master-key-reset`. */
  slug: string;
  sections: readonly SavedSection[];
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
}

export function SaveTextButton({ title, slug, sections, variant = 'secondary', size = 'md', disabled }: SaveTextButtonProps) {
  const [saved, setSaved] = useState(false);

  function save(): void {
    const now = new Date();
    downloadTextFile(savedFileName(slug, now), buildSavedText({ title, sections, now }));
    setSaved(true);
  }

  return (
    <>
      <Button variant={variant} size={size} icon="download" disabled={disabled} onClick={save}>
        {t('saveText.button')}
      </Button>
      {saved && (
        <span className="ob-small" role="status" style={{ color: 'var(--fg-secondary)' }}>
          {t('saveText.done')}
        </span>
      )}
    </>
  );
}
