/**
 * Create product share (1.4 D3, R16): the bar that appears over the Products
 * list once rows are ticked, and the dialog that offers the finished PDF.
 *
 * The PDF itself is built by the Master (`build` asks for it); here it is only
 * saved or printed. Print goes through a hidden frame so the person stays on
 * the list; a browser that will not print a PDF frame gets the PDF opened in a
 * tab of its own instead, and a browser that blocks that falls back to saving.
 */

import { useEffect, useRef, useState } from 'react';

import { Button } from './Button.js';
import { apiErrorText } from './errorText.js';
import { saveBlob } from './ImportDialog.js';
import { t } from './i18n.js';
import { Modal } from './Modal.js';
import { useToast } from './Toast.js';

export interface BuiltShare {
  blob: Blob;
  fileName: string;
}

/** Prints a PDF blob from a hidden frame; opens it in a tab if the frame cannot print. */
export function printPdfBlob(blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden';
  const cleanup = () => {
    window.setTimeout(() => {
      frame.remove();
      URL.revokeObjectURL(url);
    }, 60_000);
  };
  frame.onload = () => {
    try {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
    } catch {
      if (!window.open(url, '_blank')) saveBlob(blob, 'product-share.pdf');
    }
    cleanup();
  };
  frame.src = url;
  document.body.appendChild(frame);
}

export function ProductShareBar({
  count,
  onClear,
  build,
}: {
  /** How many products are ticked. The bar is absent at zero. */
  count: number;
  onClear: () => void;
  build: () => Promise<BuiltShare>;
}) {
  const toast = useToast();
  const buildRef = useRef(build);
  buildRef.current = build;
  const [busy, setBusy] = useState(false);
  const [built, setBuilt] = useState<(BuiltShare & { count: number }) | null>(null);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  if (count === 0 && !built) return null;

  async function create(): Promise<void> {
    setBusy(true);
    try {
      const result = await buildRef.current();
      if (mounted.current) setBuilt({ ...result, count });
    } catch (caught) {
      toast.push(apiErrorText(caught, 'productShare.failed'), { tone: 'error' });
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <>
      {count > 0 && (
        <div
          role="region"
          aria-label={t('productShare.bar')}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--s-12)',
            flexWrap: 'wrap',
            marginBottom: 'var(--s-12)',
          }}
        >
          <span className="ob-body-strong">{t('productShare.selected', { count })}</span>
          <Button variant="primary" size="sm" icon="download" disabled={busy} onClick={() => void create()}>
            {busy ? t('productShare.building') : t('productShare.create')}
          </Button>
          <Button variant="secondary" size="sm" disabled={busy} onClick={onClear}>
            {t('productShare.clear')}
          </Button>
        </div>
      )}
      <Modal
        open={built !== null}
        onClose={() => setBuilt(null)}
        title={t('productShare.ready.title')}
        subtitle={built?.fileName}
        footer={
          <>
            <Button variant="secondary" onClick={() => setBuilt(null)}>
              {t('productShare.close')}
            </Button>
            <Button variant="secondary" icon="print" onClick={() => built && printPdfBlob(built.blob)}>
              {t('productShare.print')}
            </Button>
            <Button
              variant="primary"
              icon="download"
              onClick={() => built && saveBlob(built.blob, built.fileName)}
            >
              {t('productShare.save')}
            </Button>
          </>
        }
      >
        <p style={{ margin: 0 }}>{t('productShare.ready.body', { count: built?.count ?? count })}</p>
      </Modal>
    </>
  );
}
