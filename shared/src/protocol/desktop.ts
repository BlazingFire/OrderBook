/**
 * The bridge between a panel's web UI and the desktop shell hosting it.
 *
 * Exactly one method, and it is the one thing a web page cannot do for itself:
 * run a setup file and get out of its way. Everything else about an update —
 * finding it, downloading it, checking it — happens in the panel's own server,
 * where it can be tested without a window.
 *
 * `window.orderbook` is **absent** when the UI is open in an ordinary browser
 * tab, which is how it runs in development and how an operator reaches a panel
 * from another machine. A screen must therefore treat its absence as normal and
 * fall back to showing the file path — never render a button that silently does
 * nothing.
 *
 * Only the *shape* lives here. `shared` is compiled without the DOM library,
 * because both panels' Node servers import it and a server that can name
 * `window` is a server one stray line away from calling it. Each web app owns
 * the two-line accessor; this owns the contract, which is the half that must
 * not drift.
 */

export interface DesktopBridge {
  /**
   * Launch a verified setup file and quit, so the installer can replace the
   * files this app is running from.
   *
   * The caller has already downloaded and checksummed it; this only runs it.
   * Resolves to `false` when the shell refused — a path that is not where it
   * should be, or a launch the operating system blocked — so the screen can say
   * so rather than waiting for a quit that never comes.
   */
  applyUpdate(filePath: string): Promise<boolean>;

  /** Which shell is hosting this, for the Updates screen's own diagnostics. */
  readonly panel: 'master' | 'office';
  readonly shellVersion: string;
}
