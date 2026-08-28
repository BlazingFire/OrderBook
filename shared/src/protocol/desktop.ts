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

  readonly shellVersion: string;

  /*
   * Everything below is optional on purpose.
   *
   * An already-installed shell exposes only `applyUpdate` and `shellVersion`,
   * and a panel's web bundle is updated by the same setup file as its shell
   * but not necessarily at the same moment as every *other* panel's. A caller
   * must therefore branch per method, exactly as it already has to branch on
   * the bridge being absent altogether in a browser tab.
   */

  /** Whether the panel starts with the PC, and where the shell's log lives. */
  getShellSettings?(): Promise<{ openAtLogin: boolean; logFile: string }>;
  setShellSettings?(value: { openAtLogin: boolean }): Promise<boolean>;
  openLogFolder?(): Promise<boolean>;

  /**
   * The application menu asking the page to go somewhere, by command id.
   *
   * The menu lives in the main process and cannot see the panel's routes, so
   * it sends an id and the page decides. It previously navigated by URL, to a
   * hash route the panel does not have.
   */
  onMenuCommand?(handler: (id: string) => void): void;
}

/**
 * What a panel says about itself at `GET /api/health` — the one contract the
 * desktop shell reads, from either panel.
 *
 * This exists because the shell polls this route to decide when to swap its
 * splash for the app, and the two panels answered differently: the Office
 * server had no such route at all, so its shell waited out the full timeout
 * and then declared a running server dead, and the Master's live app omitted
 * `boot` entirely, which made the shell's failure check dead code against it.
 * Annotating every implementation `satisfies PanelHealth` is what stops them
 * drifting apart again.
 *
 * The route is deliberately unauthenticated — the shell polls it before anyone
 * has signed in — and the Master binds `0.0.0.0`, so this shape is readable by
 * anything on the shop LAN. The three filesystem paths are therefore optional
 * and served only to loopback callers.
 */
export type PanelBootState = 'starting' | 'ready' | 'failed';

export interface PanelBootStatus {
  state: PanelBootState;
  /** What the panel is doing right now — shown on the splash while starting. */
  step: string;
  /** Why it stopped, in words an operator can act on. Only when `failed`. */
  message: string | null;
  detail: string | null;
}

export interface PanelHealthInterface {
  name: string;
  address: string;
  netmask: string;
  broadcastAddress: string;
}

export interface PanelHealth {
  panel: 'master' | 'office';
  status: 'ok' | 'starting';
  boot: PanelBootStatus;
  version: string;
  port: number;
  hasNetworkLink: boolean;
  interfaces: readonly PanelHealthInterface[];
  /** Loopback callers only — absent over the LAN. */
  dataDir?: string;
  logFile?: string | null;
  installerDir?: string;
}
