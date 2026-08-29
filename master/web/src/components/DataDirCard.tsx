/**
 * Where this Master keeps its data, chosen before the company is set up.
 *
 * **First-run only, and only inside the desktop app.** Two separate reasons,
 * both structural rather than cautious:
 *
 *  · The folder holds a running PostgreSQL cluster. Before setup it is empty,
 *    so moving is "restart somewhere else"; afterwards it is the company's
 *    entire database, and the honest way to move that is a backup and a
 *    restore, not a button on a screen.
 *  · The Master's page answers on `0.0.0.0`. A control here that any machine on
 *    the shop LAN could reach would let a stranger point the company's database
 *    somewhere else. The shell is the only caller that is certainly sitting at
 *    the Master PC, so the shell is the only caller offered it — a browser
 *    simply never sees this card.
 *
 * Changing it restarts the server into the new folder, which is why the button
 * says so.
 */

import { useEffect, useState } from 'react';

import { Button, Card, t } from '@orderbook/ui';

import { desktopBridge } from '../api';

export function DataDirCard() {
  const [dataDir, setDataDir] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const bridge = desktopBridge();
  const supported = Boolean(bridge?.getDataDir && bridge?.setDataDir && bridge?.chooseDirectory);

  useEffect(() => {
    if (!supported) return;
    void bridge?.getDataDir?.().then((result) => setDataDir(result.dataDir)).catch(() => undefined);
  }, [bridge, supported]);

  async function change() {
    setError(null);
    const chosen = await bridge?.chooseDirectory?.().catch(() => null);
    if (!chosen || chosen === dataDir) return;

    setBusy(true);
    try {
      // The shell writes the pointer, restarts the server and reloads this
      // window — so on success this component is about to be replaced by a
      // fresh first-run screen reading from the new folder.
      await bridge?.setDataDir?.(chosen);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('firstRun.dataDir.failed'));
      setBusy(false);
    }
  }

  // A browser has no business choosing a folder on the server's machine, and a
  // disabled control would only invite the question.
  if (!supported || !dataDir) return null;

  return (
    <Card>
      <div className="ob-eyebrow">{t('firstRun.dataDir.title')}</div>
      <p className="ob-small ob-mono" style={{ wordBreak: 'break-all' }}>
        {dataDir}
      </p>
      <p className="ob-small">{t('firstRun.dataDir.help')}</p>
      {error && <p className="ob-small">{error}</p>}
      <Button variant="secondary" busy={busy} onClick={() => void change()}>
        {t('firstRun.dataDir.change')}
      </Button>
    </Card>
  );
}
