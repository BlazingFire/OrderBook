/**
 * Products -> Photo import: attach a folder of photos named by code to their
 * sub products in one go. The matching and the run are `planPhotoImport` and
 * `runPhotoImport` in `shared/src/domain/photo-import.ts`; this screen picks
 * the files, shows the preview and the final report, and uploads each photo
 * through the ordinary product photo route (`products.edit`), one at a time,
 * waiting out the Master's upload limit when a thousand photos reach it.
 */

import { useRef, useState } from 'react';
import {
  newestImageId,
  planPhotoImport,
  runPhotoImport,
  type PhotoImportMode,
  type PhotoImportOutcome,
  type PhotoPlanRow,
  type PhotoPlanStatus,
  type Product,
} from '@orderbook/shared';
import { Button, EmptyState, ProgressBar, apiErrorText, t, useToast } from '@orderbook/ui';

import { api, ApiError } from '../api';

interface Props {
  /** The sub products the Products screen already loaded, photos included. */
  products: Product[];
}

/** A chosen file with its first bytes, which say whether it really is a photo. */
interface Item {
  name: string;
  file: File;
  head: Uint8Array;
}

/** The first bytes of a file. `FileReader` rather than `Blob.arrayBuffer`, which not every engine this runs under has. */
function readHead(file: File): Promise<Uint8Array> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    // Unreadable reads as empty, which the planner flags as not a photo.
    reader.onerror = () => resolve(new Uint8Array());
    reader.readAsArrayBuffer(file.slice(0, 16));
  });
}

const STATUSES: PhotoPlanStatus[] = ['new', 'hasPhoto', 'unmatched', 'duplicate', 'notImage'];

/** Rows drawn at once; a thousand-file folder is filtered by status rather than scrolled. */
const SHOWN_ROWS = 300;

type Filter = PhotoPlanStatus | 'imported' | 'skipped' | 'failed' | null;

export function PhotoImportScreen({ products }: Props) {
  const toast = useToast();
  const folderInput = useRef<HTMLInputElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  const stopRef = useRef(false);

  // Made from the products as they were when the files were chosen: a photo
  // the run itself adds must not move rows mid-import.
  const [plan, setPlan] = useState<PhotoPlanRow<Item>[]>([]);
  const [mode, setMode] = useState<PhotoImportMode>('skip');
  const [filter, setFilter] = useState<Filter>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [outcomes, setOutcomes] = useState<PhotoImportOutcome<Item>[] | null>(null);

  const running = progress !== null && outcomes === null;

  const count = (status: PhotoPlanStatus) => plan.filter((row) => row.status === status).length;
  const toImport = count('new') + (mode === 'replace' ? count('hasPhoto') : 0);

  const pick = async (list: FileList | null) => {
    const items = await Promise.all(
      Array.from(list ?? []).map(async (file) => ({
        name: file.name,
        file,
        head: await readHead(file),
      })),
    );
    setPlan(planPhotoImport(items, products));
    setOutcomes(null);
    setProgress(null);
    setFilter(null);
  };

  const start = async () => {
    stopRef.current = false;
    setProgress({ done: 0, total: toImport });
    const result = await runPhotoImport(plan, mode, {
      upload: async (productId, item, caption) =>
        newestImageId(await api.uploadProductImage(productId, item.file, null, caption)),
      removeImage: (productId, imageId) => api.deleteProductImage(productId, imageId),
      setPrimary: (productId, imageId) => api.updateProductImage(productId, imageId, { isPrimary: true }),
      retryAfterMs: (error) =>
        error instanceof ApiError && error.code === 'rate_limited'
          ? Number(error.details.retryAfterSeconds ?? 5) * 1000
          : null,
      errorText: (error) => apiErrorText(error, 'error.requestFailed'),
      onProgress: (done, total) => setProgress({ done, total }),
      stopped: () => stopRef.current,
    });
    setOutcomes(result);
    const tally = (kind: string) => result.filter((outcome) => outcome.result === kind).length;
    toast.push(
      t('photoImport.done', { imported: tally('imported'), skipped: tally('skipped'), failed: tally('failed') }),
      { tone: tally('failed') > 0 ? 'error' : 'ok' },
    );
  };

  const outcomeOf = new Map(outcomes?.map((outcome) => [outcome.row, outcome]));
  /** What the preview says will happen to a file, in the mode chosen. */
  const planText = (row: PhotoPlanRow<Item>): string => {
    const slot = row.slot ?? 1;
    if (row.status === 'new') return slot > 1 ? t('photoImport.status.addsSlot', { slot }) : t('photoImport.status.new');
    if (row.status === 'hasPhoto') {
      return t(mode === 'replace' ? 'photoImport.status.replacesSlot' : 'photoImport.status.keepsSlot', { slot });
    }
    if (row.status === 'duplicate') return t('photoImport.status.duplicateOf', { file: row.duplicateOf ?? '' });
    return t(`photoImport.status.${row.status}`);
  };

  const matches = (row: PhotoPlanRow<Item>): boolean => {
    if (filter === null) return true;
    const outcome = outcomeOf.get(row);
    return outcome && (filter === 'imported' || filter === 'skipped' || filter === 'failed')
      ? outcome.result === filter
      : row.status === filter;
  };
  const visible = plan.filter(matches);

  const chip = (key: Exclude<Filter, null>, label: string, value: number) => (
    <button
      key={key}
      type="button"
      className="ob-dup__chip ob-photos__chip"
      aria-pressed={filter === key}
      disabled={value === 0}
      onClick={() => setFilter(filter === key ? null : key)}
    >
      {label}: {value}
    </button>
  );

  return (
    <div className="ob-dup">
      <header className="ob-dup__head">
        <h2>{t('photoImport.title')}</h2>
        <p>{t('photoImport.description', { example: 'OPT-0011.jpg', second: 'OPT-0011_2.jpg' })}</p>
      </header>

      <div className="ob-photos__actions">
        <Button disabled={running} onClick={() => folderInput.current?.click()}>
          {t('photoImport.pickFolder')}
        </Button>
        <Button disabled={running} onClick={() => filesInput.current?.click()}>
          {t('photoImport.pickFiles')}
        </Button>
        <input
          ref={folderInput}
          type="file"
          hidden
          multiple
          {...{ webkitdirectory: '' }}
          onChange={(event) => void pick(event.target.files)}
        />
        <input
          ref={filesInput}
          type="file"
          hidden
          multiple
          accept=".jpg,.jpeg,.png,.webp"
          onChange={(event) => void pick(event.target.files)}
        />
      </div>

      {plan.length === 0 ? (
        <EmptyState title={t('photoImport.empty')} />
      ) : (
        <section className="ob-card ob-card--pad ob-dup__group">
          <div className="ob-dup__title">
            {STATUSES.map((status) => chip(status, t(`photoImport.status.${status}`), count(status)))}
          </div>
          {outcomes && (
            <div className="ob-dup__title">
              {(['imported', 'skipped', 'failed'] as const).map((kind) =>
                chip(
                  kind,
                  t(`photoImport.result.${kind}`),
                  outcomes.filter((outcome) => outcome.result === kind).length,
                ),
              )}
            </div>
          )}

          {count('hasPhoto') > 0 && !outcomes && (
            <fieldset className="ob-photos__mode" disabled={running}>
              <legend>{t('photoImport.mode.label')}</legend>
              {(['skip', 'replace'] as const).map((value) => (
                <label key={value}>
                  <input
                    type="radio"
                    name="photo-import-mode"
                    checked={mode === value}
                    onChange={() => setMode(value)}
                  />
                  {t(`photoImport.mode.${value}`)}
                </label>
              ))}
            </fieldset>
          )}

          {progress && (
            <ProgressBar
              value={progress.total === 0 ? 1 : progress.done / progress.total}
              label={t('photoImport.progress', progress)}
            />
          )}

          <div className="ob-photos__actions">
            {!outcomes && (
              <Button
                variant="primary"
                busy={running}
                disabled={running || toImport === 0}
                title={toImport === 0 ? t('photoImport.nothing') : undefined}
                onClick={() => void start()}
              >
                {t('photoImport.start', { count: toImport })}
              </Button>
            )}
            {running && (
              <Button variant="danger" onClick={() => (stopRef.current = true)}>
                {t('photoImport.stop')}
              </Button>
            )}
            {outcomes && <Button onClick={() => void pick(null)}>{t('photoImport.again')}</Button>}
          </div>

          <table className="ob-table ob-table--flat">
            <thead>
              <tr>
                <th>{t('photoImport.col.file')}</th>
                <th>{t('photoImport.col.matchedAs')}</th>
                <th>{t('photoImport.col.product')}</th>
                <th>{t('photoImport.col.status')}</th>
              </tr>
            </thead>
            <tbody>
              {visible.slice(0, SHOWN_ROWS).map((row, index) => {
                const outcome = outcomeOf.get(row);
                return (
                  <tr key={`${index}:${row.fileName}`}>
                    <td>{row.fileName}</td>
                    <td>{row.matchedAs ?? ''}</td>
                    <td>{row.productName ?? ''}</td>
                    <td>
                      {outcome ? `${t(`photoImport.result.${outcome.result}`)} - ${planText(row)}` : planText(row)}
                      {outcome?.error && <em className="ob-dup__blocked"> {outcome.error}</em>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {visible.length > SHOWN_ROWS && (
            <p className="ob-small">{t('photoImport.shownOf', { shown: SHOWN_ROWS, total: visible.length })}</p>
          )}
        </section>
      )}
    </div>
  );
}
