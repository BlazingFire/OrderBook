/**
 * Restore products from a product backup zip (Master only), or from the
 * products .csv or .xlsx an earlier version exported: choose the file, read
 * what it would do, tick the removals if wanted (or make the catalogue exactly
 * the file), Apply, watch it run, read what it did.
 *
 * The preview is the Master's own dry run of the same restore
 * (`master/src/services/product-zip.service.ts`), with the exact catalogue
 * ticked or not as it is here (it reads the file otherwise, so ticking it reads
 * the file again), so what is listed here is what Apply does. Apply uploads the
 * zip again and starts the restore as a job
 * on the Master; this dialog only follows it, so closing it stops nothing, and
 * opening it again while a restore runs shows that one.
 *
 * Not `ImportDialog`: that one is shared with the party import and has no
 * opt-ins, no job and no photos, and the party import stays as it is.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  ProductCellChange,
  ProductRestoreJob,
  ProductRestoreOptions,
  ProductZipList,
  ProductZipReport,
} from '@orderbook/shared';
import { MAX_PRODUCT_ZIP_BYTES } from '@orderbook/shared';

import { BusyMark } from './BusyMark.js';
import { Button } from './Button.js';
import type { ProductZipTransport } from './catalogueSummary.js';
import { apiErrorText } from './errorText.js';
import { Checkbox } from './Form.js';
import { t } from './i18n.js';
import { Modal } from './Modal.js';
import { rem } from './rem.js';
import { ProgressBar } from './TopProgress.js';

/** How often a running restore is asked where it is. */
const POLL_MS = 1000;

/** What a phase is called on screen, written out so each key is checked against the catalogue. */
const PHASE_KEY: Record<ProductRestoreJob['phase'], string> = {
  checking: 'productZip.phase.checking',
  products: 'productZip.phase.products',
  photos: 'productZip.phase.photos',
  removing: 'productZip.phase.removing',
  done: 'productZip.phase.removing',
  failed: 'productZip.phase.removing',
};

type Step = 'pick' | 'preview' | 'running' | 'done';

const cells = (fields: ProductCellChange[]): string =>
  fields
    .map((field) =>
      t('productZip.cellChange', {
        column: field.column,
        from: field.from || '—',
        to: field.to || '—',
      }),
    )
    .join('; ');

/** One line of a section: a count, and the names behind it when there are any. */
function Item({ label, items }: { label: string; items?: string[] }) {
  if (!items || items.length === 0) return <li>{label}</li>;
  return (
    <li>
      <details>
        <summary style={{ cursor: 'pointer' }}>{label}</summary>
        <ul
          className="ob-small"
          style={{ margin: 'var(--s-4) 0 0', maxHeight: rem(180), overflow: 'auto' }}
        >
          {items.map((item, index) => (
            <li key={`${index}:${item}`}>{item}</li>
          ))}
        </ul>
      </details>
    </li>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
      <h3 className="ob-body-strong" style={{ margin: 0 }}>
        {title}
      </h3>
      <ul
        style={{
          margin: 0,
          paddingLeft: 'var(--s-20)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--s-4)',
        }}
      >
        {children}
      </ul>
    </section>
  );
}

const some = (count: number, node: ReactNode) => (count > 0 ? node : null);

/** What a list file does; absent (`brands`) from a Master older than 1.4.7. */
const listCount = (list?: ProductZipList): number =>
  list ? list.added.length + list.changed.length + (list.reordered ? 1 : 0) : 0;

/** `colours.csv` or `brands.csv`: the values it adds and changes, the list put in its order, and the values it leaves out. */
function ListSection({ title, list }: { title: string; list?: ProductZipList }) {
  const gone = list?.notInFile ?? [];
  if (!list || listCount(list) + gone.length === 0) return null;
  return (
    <Section title={title}>
      {some(
        list.added.length,
        <Item
          label={t('productZip.item.added', { count: list.added.length })}
          items={list.added}
        />,
      )}
      {some(
        list.changed.length,
        <Item
          label={t('productZip.item.changed', { count: list.changed.length })}
          items={list.changed.map(
            (change) => `${change.column}: ${change.from || '—'} → ${change.to || '—'}`,
          )}
        />,
      )}
      {list.reordered && <Item label={t('productZip.item.listReordered')} />}
      {some(
        gone.length,
        <Item label={t('productZip.item.listNotInFile', { count: gone.length })} items={gone} />,
      )}
    </Section>
  );
}

const named = (row: { code: string; name: string }): string =>
  row.code ? `${row.code} — ${row.name}` : row.name;

/** What the zip changes; a count of 0 is left out, except where saying "unchanged" is the point. */
function ReportView({ report }: { report: ProductZipReport }) {
  const { mainProducts, products, rows, colours, brands, photos, problems } = report;
  // Absent from a Master older than 1.4.7, and where there are none.
  const restored = mainProducts.restoredFromBin ?? [];
  const mainsGone = mainProducts.notInFile ?? [];
  const rowsBack = rows.restoredFromBin ?? [];
  const rowsReordered = rows.reordered ?? [];
  const variantsGone = rows.variantsNotInFile ?? [];
  const recaptioned = photos.recaptioned ?? [];
  const reordered = photos.reordered ?? [];
  return (
    <>
      {some(
        mainProducts.added.length +
          mainProducts.renamed.length +
          restored.length +
          mainsGone.length,
        <Section title={t('productZip.section.mainProducts')}>
          {some(
            mainProducts.added.length,
            <Item
              label={t('productZip.item.added', { count: mainProducts.added.length })}
              items={mainProducts.added.map(
                (main) => `${main.code} — ${main.name}${main.brand ? ` (${main.brand})` : ''}`,
              )}
            />,
          )}
          {some(
            mainProducts.renamed.length,
            <Item
              label={t('productZip.item.changed', { count: mainProducts.renamed.length })}
              items={mainProducts.renamed.map((main) => `${main.code}: ${cells(main.fields)}`)}
            />,
          )}
          {some(
            restored.length,
            <Item
              label={t('productZip.item.restoredFromBin', { count: restored.length })}
              items={restored.map((main) => `${main.code} — ${main.name}`)}
            />,
          )}
          {some(
            mainsGone.length,
            <Item
              label={t('productZip.item.mainNotInFile', { count: mainsGone.length })}
              items={mainsGone.map(named)}
            />,
          )}
        </Section>,
      )}
      <Section title={t('productZip.section.rows')}>
        {some(
          rows.added.length,
          <Item
            label={t('productZip.item.added', { count: rows.added.length })}
            items={rows.added.map((row) => `${row.code} — ${row.name}`)}
          />,
        )}
        {some(
          rows.changed.length,
          <Item
            label={t('productZip.item.changed', { count: rows.changed.length })}
            items={rows.changed.map((row) => `${row.code} — ${row.name}: ${cells(row.fields)}`)}
          />,
        )}
        {some(
          rowsBack.length,
          <Item
            label={t('productZip.item.restoredFromBin', { count: rowsBack.length })}
            items={rowsBack.map(
              (row) =>
                `${row.code} — ${row.name}${row.fields.length > 0 ? `: ${cells(row.fields)}` : ''}`,
            )}
          />,
        )}
        {some(
          rowsReordered.length,
          <Item
            label={t('productZip.item.rowsReordered', { count: rowsReordered.length })}
            items={rowsReordered.map(named)}
          />,
        )}
        <Item label={t('productZip.item.unchanged', { count: products.unchanged ?? 0 })} />
        {some(
          rows.notInFile.length,
          <Item
            label={t('productZip.item.notInFile', { count: rows.notInFile.length })}
            items={rows.notInFile.map((row) => `${row.code} — ${row.name}`)}
          />,
        )}
        {some(
          variantsGone.length,
          <Item
            label={t('productZip.item.variantsNotInFile', { count: variantsGone.length })}
            items={variantsGone.map((row) => `${row.code} — ${row.name}`)}
          />,
        )}
        {some(
          products.failed + products.skipped,
          <Item
            label={t('productZip.item.issues', { count: products.failed + products.skipped })}
            items={products.issues.map(
              (issue) =>
                `${t('import.column.row')} ${issue.row}${issue.column ? ` (${issue.column})` : ''}: ${t(issue.messageKey, issue.params)}`,
            )}
          />,
        )}
      </Section>
      <ListSection title={t('productZip.section.colours')} list={colours} />
      {colours.noFile && (
        <Section title={t('productZip.section.colours')}>
          <Item label={t('productZip.item.noColoursFile')} />
        </Section>
      )}
      <ListSection title={t('productZip.section.brands')} list={brands} />
      <Section title={t('productZip.section.photos')}>
        {some(
          photos.added.length,
          <Item
            label={t('productZip.item.added', { count: photos.added.length })}
            items={photos.added}
          />,
        )}
        {some(
          photos.replaced.length,
          <Item
            label={t('productZip.item.replaced', { count: photos.replaced.length })}
            items={photos.replaced}
          />,
        )}
        {some(
          recaptioned.length,
          <Item
            label={t('productZip.item.recaptioned', { count: recaptioned.length })}
            items={recaptioned}
          />,
        )}
        {some(
          reordered.length,
          <Item
            label={t('productZip.item.reordered', { count: reordered.length })}
            items={reordered}
          />,
        )}
        <Item label={t('productZip.item.unchanged', { count: photos.unchanged })} />
        {photos.noFile && <Item label={t('productZip.item.noPhotosFile')} />}
        {some(
          photos.notInZip.length,
          <Item
            label={t('productZip.item.notInZip', { count: photos.notInZip.length })}
            items={photos.notInZip}
          />,
        )}
        {some(
          photos.unmatched.length,
          <Item
            label={t('productZip.item.unmatched', { count: photos.unmatched.length })}
            items={photos.unmatched}
          />,
        )}
        {some(
          photos.duplicate.length,
          <Item
            label={t('productZip.item.duplicate', { count: photos.duplicate.length })}
            items={photos.duplicate}
          />,
        )}
        {some(
          photos.notImage.length,
          <Item
            label={t('productZip.item.notImage', { count: photos.notImage.length })}
            items={photos.notImage}
          />,
        )}
      </Section>
      {some(
        problems.length,
        <Section title={t('import.preview.issues')}>
          <Item
            label={t('productZip.item.problems', { count: problems.length })}
            items={problems.map(
              (problem) => `${problem.subject}: ${t(problem.messageKey, problem.params)}`,
            )}
          />
        </Section>,
      )}
    </>
  );
}

/** What only "Make the catalogue exactly this file" takes out. */
const exactOnly = (report: ProductZipReport): number =>
  (report.mainProducts.notInFile?.length ?? 0) +
  (report.rows.variantsNotInFile?.length ?? 0) +
  (report.colours.notInFile?.length ?? 0) +
  (report.brands?.notInFile?.length ?? 0);

/** Anything for Apply to do, with these opt-ins; the exact catalogue implies the other two. */
function changes(report: ProductZipReport, options: ProductRestoreOptions): number {
  const exact = options.exactCatalogue === true;
  return (
    report.mainProducts.added.length +
    report.mainProducts.renamed.length +
    (report.mainProducts.restoredFromBin?.length ?? 0) +
    report.products.created +
    report.products.updated +
    (report.rows.reordered?.length ?? 0) +
    listCount(report.colours) +
    listCount(report.brands) +
    report.photos.added.length +
    report.photos.replaced.length +
    (report.photos.recaptioned?.length ?? 0) +
    (report.photos.reordered?.length ?? 0) +
    (options.binMissingProducts || exact ? report.rows.notInFile.length : 0) +
    (options.removeMissingPhotos || exact ? report.photos.notInZip.length : 0) +
    (exact ? exactOnly(report) : 0)
  );
}

export function ProductZipModal({
  open,
  transport,
  canDelete,
  onClose,
  onRestored,
}: {
  open: boolean;
  transport: ProductZipTransport;
  /** `products.delete`: without it the Recycle Bin opt-in is not offered. */
  canDelete: boolean;
  onClose: () => void;
  /** A restore finished; the catalogue should refetch. */
  onRestored: () => void;
}) {
  // Held in refs: a host that rebuilds its transport or callback per render must not restart the poll.
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const restoredRef = useRef(onRestored);
  restoredRef.current = onRestored;

  const [step, setStep] = useState<Step>('pick');
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<ProductZipReport | null>(null);
  const [options, setOptions] = useState<ProductRestoreOptions>({});
  const [job, setJob] = useState<ProductRestoreJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function reset(): void {
    setStep('pick');
    setFile(null);
    setReport(null);
    setOptions({});
    setJob(null);
    setFailure(null);
  }

  /** A running restore is kept to follow on the next open; anything else starts over. */
  function close(): void {
    if (step !== 'running') reset();
    onClose();
  }

  // Opened while a restore runs (started here earlier, or by somebody else): follow that one.
  useEffect(() => {
    if (!open) return undefined;
    let stopped = false;
    transportRef.current
      .job()
      .then((current) => {
        if (!stopped && current && !current.finishedAt) {
          setJob(current);
          setStep('running');
        }
      })
      .catch(() => undefined);
    return () => {
      stopped = true;
    };
  }, [open]);

  const running = open && step === 'running';
  useEffect(() => {
    if (!running) return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = (): void => {
      timer = setTimeout(() => {
        transportRef.current.job().then(
          (next) => {
            if (stopped) return;
            if (!next) {
              // The Master restarted, and the restore with it.
              setFailure(t('productZip.failed'));
              setStep('done');
              return;
            }
            setJob(next);
            if (!next.finishedAt) {
              poll();
              return;
            }
            if (next.phase === 'done' && next.result) {
              setReport(next.result);
              restoredRef.current();
            } else {
              setFailure(
                next.message
                  ? t(next.message.messageKey, next.message.params)
                  : t('productZip.failed'),
              );
            }
            setStep('done');
          },
          () => {
            if (!stopped) poll();
          },
        );
      }, POLL_MS);
    };
    poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [running]);

  /**
   * The preview of the run these opt-ins ask for. The opt-ins take effect with
   * their report, so what is listed is always what Apply does; a refused one
   * leaves both as they were.
   */
  async function check(chosen: File, next: ProductRestoreOptions): Promise<boolean> {
    setFailure(null);
    setBusy(true);
    try {
      setReport(await transportRef.current.preview(chosen, next));
      setOptions(next);
      return true;
    } catch (caught) {
      setFailure(apiErrorText(caught, 'productZip.failed'));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function choose(chosen: File): Promise<void> {
    if (busy) return;
    // A backup zip, or the products sheet an earlier version exported.
    if (!/\.(zip|csv|xlsx)$/i.test(chosen.name)) {
      setFailure(t('validation.productZip.fileRequired'));
      return;
    }
    if (chosen.size > MAX_PRODUCT_ZIP_BYTES) {
      setFailure(t('validation.productZip.tooLarge'));
      return;
    }
    setFile(chosen);
    if (await check(chosen, {})) setStep('preview');
  }

  async function apply(): Promise<void> {
    if (!file || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      setJob(await transportRef.current.start(file, options));
      setStep('running');
    } catch (caught) {
      setFailure(apiErrorText(caught, 'productZip.failed'));
    } finally {
      setBusy(false);
    }
  }

  const exact = options.exactCatalogue === true;
  const toDo = report ? changes(report, options) : 0;
  const note = (text: ReactNode) => (
    <p className="ob-small" style={{ margin: 0, color: 'var(--fg-secondary)' }}>
      {text}
    </p>
  );
  const reading = busy && (
    <p
      className="ob-small"
      style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 'var(--s-8)' }}
    >
      <BusyMark size={16} label="" />
      {t('productZip.checking')}
    </p>
  );

  const footer =
    step === 'preview' ? (
      <>
        <Button variant="secondary" onClick={reset} disabled={busy}>
          {t('common.cancel')}
        </Button>
        <Button variant="primary" busy={busy} disabled={toDo === 0} onClick={() => void apply()}>
          {t('productZip.apply')}
        </Button>
      </>
    ) : step === 'done' ? (
      <>
        <Button variant="secondary" onClick={reset}>
          {t('productZip.another')}
        </Button>
        <Button variant="primary" onClick={close}>
          {t('common.close')}
        </Button>
      </>
    ) : (
      <Button variant="secondary" onClick={close} disabled={busy}>
        {t('common.close')}
      </Button>
    );

  const phase = job?.phase;
  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : close}
      size="lg"
      title={t('productZip.title')}
      footer={footer}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
        {step === 'pick' && (
          <>
            {note(t('productZip.intro'))}
            <div>
              <Button
                variant="secondary"
                icon="upload"
                busy={busy}
                disabled={busy}
                onClick={() => fileInputRef.current?.click()}
              >
                {t('productZip.choose')}
              </Button>
            </div>
            {reading}
            <input
              ref={fileInputRef}
              type="file"
              accept=".zip,.csv,.xlsx,application/zip"
              hidden
              data-testid="product-zip-file"
              onChange={(event) => {
                const chosen = event.target.files?.[0];
                event.target.value = '';
                if (chosen) void choose(chosen);
              }}
            />
          </>
        )}

        {step === 'preview' && report && (
          <>
            <p className="ob-body-strong" style={{ margin: 0 }}>
              {report.fileName}
            </p>
            <ReportView report={report} />
            {report.rows.notInFile.length + report.photos.notInZip.length + exactOnly(report) >
              0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-8)' }}>
                {note(t('productZip.reportOnly'))}
                {canDelete && report.rows.notInFile.length > 0 && (
                  <Checkbox
                    checked={options.binMissingProducts === true || exact}
                    disabled={exact || busy}
                    onChange={(checked) =>
                      setOptions((current) => ({ ...current, binMissingProducts: checked }))
                    }
                    label={t('productZip.opt.bin', { count: report.rows.notInFile.length })}
                  />
                )}
                {report.photos.notInZip.length > 0 && (
                  <>
                    <Checkbox
                      checked={options.removeMissingPhotos === true || exact}
                      disabled={exact || busy}
                      onChange={(checked) =>
                        setOptions((current) => ({ ...current, removeMissingPhotos: checked }))
                      }
                      label={t('productZip.opt.photos', { count: report.photos.notInZip.length })}
                    />
                    {options.removeMissingPhotos && !exact && note(t('productZip.opt.photos.hint'))}
                  </>
                )}
                {/* Sub products, main products, colours and brands go to the Bin: the delete
                    permission, and the lists' own one for a colour or brand (`exactNeedsLists`).
                    Ticked or not, it is previewed again: the exact run reads the file otherwise. */}
                {canDelete && (
                  <>
                    <Checkbox
                      checked={exact}
                      disabled={busy || report.exactNeedsLists === true}
                      onChange={(checked) => {
                        if (file) void check(file, { ...options, exactCatalogue: checked });
                      }}
                      label={t('productZip.opt.exact')}
                    />
                    {note(t('productZip.opt.exact.hint'))}
                    {report.colours.noFile && note(t('productZip.opt.exact.keepsColours'))}
                    {report.photos.noFile && note(t('productZip.opt.exact.keepsPhotos'))}
                    {report.exactNeedsLists && note(t('productZip.opt.exact.needsLists'))}
                    {report.colours.switchedOff && note(t('productZip.opt.exact.switchedOff'))}
                  </>
                )}
              </div>
            )}
            {reading}
            {toDo === 0 && note(t('productZip.nothing'))}
          </>
        )}

        {step === 'running' && (
          <>
            <ProgressBar
              value={phase === 'photos' && job && job.total > 0 ? job.done / job.total : null}
              label={t(PHASE_KEY[phase ?? 'checking'])}
              detail={
                phase === 'photos' && job
                  ? t('productZip.photoProgress', { done: job.done, total: job.total })
                  : undefined
              }
            />
            {note(t('productZip.runningHint'))}
          </>
        )}

        {step === 'done' && (
          <>
            {report && !failure && (
              <>
                <p className="ob-body-strong" style={{ margin: 0 }}>
                  {t('productZip.done')}
                </p>
                {(report.binned ?? 0) > 0 &&
                  note(t('productZip.done.binned', { count: report.binned ?? 0 }))}
                {(report.photosRemoved ?? 0) > 0 &&
                  note(t('productZip.done.photosRemoved', { count: report.photosRemoved ?? 0 }))}
                {report.exactRemoved && note(t('productZip.done.exact', report.exactRemoved))}
                <ReportView report={report} />
              </>
            )}
          </>
        )}

        {failure && (
          <p
            className="ob-small"
            role="alert"
            style={{ margin: 0, color: 'var(--danger, #b42318)' }}
          >
            {failure}
          </p>
        )}
      </div>
    </Modal>
  );
}
