/**
 * One signal that aborts when any of `signals` does: `AbortSignal.any` for
 * Chromium 108.
 *
 * `AbortSignal.any` arrived in Chromium 116. The Windows 7 Office build runs
 * Electron 22 (Chromium 108), and a Win7 PC opens the Master UI in Chrome 109,
 * so both panels' `api.ts` call this instead.
 *
 * The result aborts with the reason of the first input to abort. Once it has,
 * the listeners on the other inputs are removed, so a later abort of one of
 * them does nothing.
 */
export function anySignal(signals: readonly AbortSignal[]): AbortSignal {
  for (const signal of signals) {
    if (signal.aborted) return AbortSignal.abort(signal.reason);
  }

  const controller = new AbortController();
  const settle = (source: AbortSignal): void => {
    for (const signal of signals) signal.removeEventListener('abort', listeners.get(signal)!);
    controller.abort(source.reason);
  };
  const listeners = new Map<AbortSignal, () => void>();
  for (const signal of signals) {
    const listener = (): void => settle(signal);
    listeners.set(signal, listener);
    signal.addEventListener('abort', listener, { once: true });
  }
  return controller.signal;
}
