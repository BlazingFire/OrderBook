/**
 * Back up and Restore for one section (Products, Orders or Parties), on that section's own
 * screen. Restore shows what it would do first; nothing is written before it is confirmed.
 */

import { useRef, useState } from 'react';
import type { SectionBackupName, SectionRestoreResult } from '@orderbook/shared';
import { Button, Modal, apiErrorText, formatDateTime, saveBlob, t, useToast } from '@orderbook/ui';

import { api } from '../api';

export function SectionBackup({ section, permissions }: { section: SectionBackupName; permissions: readonly string[] }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [chosen, setChosen] = useState<{ file: File; preview: SectionRestoreResult } | null>(null);

  if (!permissions.includes('storage.manage')) return null;

  const run = (work: () => Promise<void>): void => {
    setBusy(true);
    work()
      .catch((caught) => toast.push(apiErrorText(caught, 'error.requestFailed'), { tone: 'error' }))
      .finally(() => setBusy(false));
  };

  const backup = (): void =>
    run(async () => {
      const { blob, fileName } = await api.backupSection(section);
      saveBlob(blob, fileName);
      toast.push(t('backup.section.saved', { file: fileName }), { tone: 'ok' });
    });
  const restore = (file: File): void =>
    run(async () => {
      const done = await api.restoreSection(section, file, true);
      setChosen(null);
      toast.push(t('backup.section.done', { added: done.added, changed: done.changed }), { tone: 'ok' });
    });

  const preview = chosen?.preview;
  const nothing = preview && preview.added + preview.changed + preview.photos === 0;

  return (
    <>
      <Button variant="secondary" size="sm" icon="download" busy={busy} onClick={backup}>
        {t('backup.section.backup')}
      </Button>
      <Button variant="secondary" size="sm" icon="upload" disabled={busy} onClick={() => input.current?.click()}>
        {t('backup.section.restore')}
      </Button>
      <input
        ref={input}
        type="file"
        accept=".zip"
        hidden
        aria-label={t('backup.section.restore')}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) run(async () => setChosen({ file, preview: await api.restoreSection(section, file, false) }));
        }}
      />
      {chosen && preview && (
        <Modal
          open
          onClose={() => setChosen(null)}
          title={t(`backup.section.title.${section}`)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setChosen(null)}>
                {t('common.cancel')}
              </Button>
              <Button variant="primary" busy={busy} disabled={nothing} onClick={() => restore(chosen.file)}>
                {t('backup.section.restore')}
              </Button>
            </>
          }
        >
          <p className="ob-body">
            {t('backup.section.from', { company: preview.company, date: formatDateTime(preview.createdAt) })}
          </p>
          {!preview.sameCompany && <p className="ob-body">{t('backup.section.otherMaster')}</p>}
          <p className="ob-body">
            {t('backup.section.counts', { added: preview.added, changed: preview.changed, unchanged: preview.unchanged })}
          </p>
          {preview.photos > 0 && <p className="ob-body">{t('backup.section.photos', { count: preview.photos })}</p>}
          {preview.skipped.length > 0 && (
            <>
              <p className="ob-body">{t('backup.section.skipped', { count: preview.skipped.length })}</p>
              <ul className="ob-small">
                {preview.skipped.slice(0, 10).map((row, index) => (
                  <li key={index}>{t('backup.section.skippedRow', { label: row.label, reason: row.reason })}</li>
                ))}
              </ul>
            </>
          )}
          <p className="ob-small">{nothing ? t('backup.section.nothing') : t('backup.section.note')}</p>
        </Modal>
      )}
    </>
  );
}
