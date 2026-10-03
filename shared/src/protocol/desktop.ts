/**
 * The bridge between a panel's web UI and the desktop shell hosting it.
 *
 * One method is required, `applyUpdate`, and it is the one thing a web page
 * cannot do for itself: run a setup file and get out of its way. Everything
 * else about an update — finding it, downloading it, checking it — happens in
 * the panel's own server, where it can be tested without a window. Beside it
 * sit the shell's version and optional methods for the other things only a
 * shell can do, from a native folder chooser to uninstalling — optional
 * because older shells lack them (see the note inside the interface).
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
   * Install the update the panel has already prepared and verified, and quit
   * so the installer can replace the files this app is running from.
   *
   * Deliberately takes no path: the renderer does not choose what executes.
   * The shell asks the panel over loopback and hashes the file itself before
   * spawning it. Resolves to `false` when the shell refused — a standalone
   * build, a panel that did not answer its own health check, no verified
   * installer ready, a file that fails the shell's own checks, or a launch the
   * operating system blocked — so the screen can say so rather than waiting
   * for a quit that never comes.
   */
  applyUpdate(): Promise<boolean>;

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

  /**
   * Ask the shell to open a native folder chooser, for the storage path.
   *
   * A browser cannot offer one for an arbitrary path, so a plain tab falls back
   * to a text field and this stays undefined — which is why the caller checks
   * for the method rather than only for the bridge.
   */
  chooseDirectory?(): Promise<string | null>;

  /** Where this installation keeps its data, and whether that is still the default. */
  getDataDir?(): Promise<{ dataDir: string; isDefault: boolean }>;

  /**
   * Point this installation at another folder and restart the server into it.
   *
   * Offered on the **first-run screen only**. After setup the Master's folder
   * holds a live database and its page is reachable from the whole LAN, so
   * moving it is a backup and a restore rather than a button.
   */
  setDataDir?(dataDir: string): Promise<boolean>;

  /**
   * Whether the panel starts with the PC, where the shell's log lives, and
   * whether this is the **standalone** build — the single `.exe` that runs
   * without being installed. A standalone build cannot install an update over
   * itself (`applyUpdate` refuses), so the Updates screen tells the operator
   * to replace the file instead of offering a button. Absent from shells older
   * than 1.2.0, which are all installed builds.
   *
   * `systemPackage` is the same answer for a Linux copy not started from an
   * AppImage — in a shipped build, one installed from the `.deb`, which only
   * the system's package manager can replace; `applyUpdate` refuses it too.
   * Absent from shells that predate it, none of which could update on Linux
   * at all.
   */
  getShellSettings?(): Promise<{
    openAtLogin: boolean;
    logFile: string;
    standalone?: boolean;
    systemPackage?: boolean;
  }>;
  setShellSettings?(value: { openAtLogin: boolean }): Promise<boolean>;
  openLogFolder?(): Promise<boolean>;

  /**
   * Remove this panel from the machine: hand one of the uninstall scripts to
   * the operating system, then quit so it can delete what we are running from.
   *
   * Shell only — a browser tab never sees this, and that is not a limitation
   * to work around. A page cannot delete the program serving it, and an
   * operator sitting at another machine has no business uninstalling the PC
   * they happen to be looking at.
   *
   * `keepData` true leaves the database, uploads and settings on disk. The
   * shell asks for confirmation natively before anything happens, so this
   * resolves `false` on a cancel — and equally on a platform we ship no
   * uninstaller for, a build missing the script, or a spawn the OS refused.
   * A `true` is the last thing the page will hear; the window is going away.
   */
  uninstall?(options: { keepData: boolean }): Promise<boolean>;

  /**
   * The application menu asking the page to go somewhere, by command id.
   *
   * The menu lives in the main process and cannot see the panel's routes, so
   * it sends an id and the page decides. It previously navigated by URL, to a
   * hash route the panel does not have.
   */
  onMenuCommand?(handler: (id: string) => void): void;

  /** The printers Windows knows on this PC, for the order-note preview's picker. */
  listPrinters?(): Promise<PrinterInfo[]>;

  /**
   * Print the page as it stands, on A4 with no margins, using its print
   * stylesheet — the order-note preview's Print button.
   *
   * With `deviceName` the job goes straight to that printer; without it the
   * system's print dialog opens. A name the shell cannot find among the
   * installed printers also opens the dialog rather than failing, so a
   * remembered printer that has been unplugged never blocks a print.
   *
   * `copies` is a whole number 1..50 (anything else prints one), collated.
   */
  printPage?(options: { deviceName?: string; copies?: number }): Promise<{ ok: boolean; error?: string }>;

  /**
   * Save the page as a PDF (A4, its print stylesheet). The shell shows its own
   * Save dialog and writes the file; the page offers only a file name, which
   * the shell cleans. A closed dialog is `{ ok: false, cancelled: true }`.
   */
  savePdf?(options: {
    fileName: string;
  }): Promise<{ ok: boolean; path?: string; cancelled?: boolean; error?: string }>;

  /**
   * Show a system notification and flash the taskbar button, for something the
   * operator should see even with the window behind another one. Resolves
   * `false` when the shell could not show it.
   */
  notify?(notice: { title: string; body: string }): Promise<boolean>;
}

export interface PrinterInfo {
  name: string;
  displayName: string;
  isDefault: boolean;
}

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
 * anything on the shop LAN. The filesystem paths, the prepared installer and
 * the runtime figures are therefore optional and served only to loopback
 * callers.
 */
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
  /**
   * The setup file this panel is prepared to install, and the digest it must
   * match. Loopback only, like the paths above.
   *
   * The shell reads this rather than being handed a path by the renderer.
   * Until it did, `applyUpdate(path)` took the path *from the window* and the
   * shell checked only that it sat inside `installerDir` — so anything that
   * could write that folder chose what ran with the operator's elevation, and
   * the checksum the comment claimed had been verified was verified by a
   * different process, minutes earlier, against a file free to change since.
   * The shell now hashes the bytes itself, immediately before it spawns them.
   */
  installer?: PreparedInstaller | null;
  /**
   * What the process is holding right now. Loopback only, like the paths above.
   *
   * Here rather than in a log because these are the figures somebody wants
   * *while* a panel feels slow, and a log tells them what it was holding an
   * hour ago. Optional so an older panel answering this route still parses.
   */
  runtime?: PanelRuntimeHealth;
}

/** A setup file a panel has downloaded, verified, and is willing to have run. */
export interface PreparedInstaller {
  /** Absolute path, inside the panel's own installer directory. */
  path: string;
  /** Lowercase hex SHA-256 the bytes must still hash to at the moment of launch. */
  sha256: string;
  version: string;
}

export interface PanelRuntimeHealth {
  rssBytes: number;
  heapUsedBytes: number;
  /** In-memory sign-in sessions. Master only; 0 on the Office panel. */
  sessions: number;
  panelSockets: number;
  adminSockets: number;
  /** How many changes this run of the Master has published. */
  changeRingSeq: number;
}
