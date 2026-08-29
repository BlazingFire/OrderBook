/**
 * Where this panel keeps its files, chosen from the sign-in screen.
 *
 * Collapsed to one line until somebody opens it, because on a working day
 * nobody is changing the data folder and it must not compete with the password
 * field. Setting up a new PC is the case it exists for, and that happens before
 * there is anybody to sign in as.
 *
 * **The picker is native when there is a shell to ask.** A browser cannot offer
 * a folder chooser for an arbitrary path, so in a plain tab this is a text
 * field — honest rather than broken. The desktop app gets a real "Browse…".
 *
 * Moving is the panel's own `relocateDataDir`, which copies what is there and
 * refuses the cases that would lose work — a target inside the current folder,
 * a disk without room. Its refusal is shown verbatim, because it names the
 * actual reason.
 */

import { useEffect, useState } from 'react';

import { Button, Card, FormField, Input, t } from '@orderbook/ui';

import { api, desktopBridge } from '../api';

export function StoragePathCard() {
  const [open, setOpen] = useState(false);
  const [dataDir, setDataDir] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moved, setMoved] = useState<string | null>(null);

  useEffect(() => {
    void api
      .storagePath()
      .then((result) => {
        setDataDir(result.dataDir);
        setDraft(result.dataDir);
      })
      .catch(() => setDataDir(null));
  }, []);

  const bridge = desktopBridge();

  async function browse() {
    const chosen = await bridge?.chooseDirectory?.().catch(() => null);
    if (chosen) setDraft(chosen);
  }

  async function apply() {
    setBusy(true);
    setError(null);
    setMoved(null);

    try {
      const result = await api.setStoragePath(draft.trim());
      setDataDir(result.dataDir);
      setDraft(result.dataDir);
      setMoved(t('storage.moved', { count: result.filesMoved }));
      setOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('storage.failed'));
    } finally {
      setBusy(false);
    }
  }

  // Nothing to say until the panel has answered where it is.
  if (!dataDir) return null;

  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-8)' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="ob-eyebrow">{t('storage.title')}</div>
          <div className="ob-small ob-mono" style={{ wordBreak: 'break-all' }}>
            {dataDir}
          </div>
        </div>
        <Button variant="secondary" onClick={() => setOpen((current) => !current)}>
          {open ? t('common.cancel') : t('storage.change')}
        </Button>
      </div>

      {moved && <p className="ob-small">{moved}</p>}

      {open && (
        <div style={{ marginTop: 'var(--s-12)' }}>
          <p className="ob-small">{t('storage.help')}</p>

          <FormField label={t('storage.folder')}>
            {(id) => (
              <div style={{ display: 'flex', gap: 'var(--s-8)' }}>
                <Input
                  id={id}
                  value={draft}
                  className="ob-mono"
                  onChange={(event) => setDraft(event.target.value)}
                />
                {/* Only where a shell can open one. A browser has no way to
                    choose an arbitrary folder, and a dead button is worse than
                    an absent one. */}
                {bridge?.chooseDirectory && (
                  <Button variant="secondary" onClick={() => void browse()}>
                    {t('storage.browse')}
                  </Button>
                )}
              </div>
            )}
          </FormField>

          {error && <p className="ob-small">{error}</p>}

          <div style={{ display: 'flex', gap: 'var(--s-8)', marginTop: 'var(--s-8)' }}>
            <span style={{ flex: 1 }} />
            <Button
              variant="primary"
              busy={busy}
              disabled={!draft.trim() || draft.trim() === dataDir}
              onClick={() => void apply()}
            >
              {t('storage.move')}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
