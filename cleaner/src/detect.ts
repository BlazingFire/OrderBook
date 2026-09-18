/**
 * Reading what the uninstall scripts say they would do.
 *
 * `tools/uninstall/uninstall-orderbook.{ps1,sh}` already know the complete
 * footprint — every folder, registry key, shortcut and firewall rule this
 * product leaves on a PC — and `-DryRun` / `--dry-run` prints the whole plan
 * without touching anything. That inventory is the hard part and it exists, so
 * this module reads it rather than growing a second opinion about what
 * OrderBook installs. A second list is how the tool that claims to remove
 * everything comes to miss something.
 *
 * Both scripts emit the same line shape, which is the contract this parses:
 *
 *   [dry-run] would remove <what>: <path>
 *   [dry-run] would remove <what>: <path> (absent)
 *
 * They group differently, and that is kept rather than normalised: the shell
 * script heads each section with a panel (`-- OrderBook Master Panel`) and the
 * PowerShell one with a category (`-- Program folders`). Each script chose the
 * grouping that suits what it can see on its own OS, and re-deriving a common
 * one here would be a second opinion that can disagree with the thing actually
 * doing the removing.
 *
 * Pure: no spawning, no filesystem. `cleaner/src/run-script.ts` does that and
 * hands the text here, which is what lets every case below be a fixture.
 */

/** One path the script named, in the section it named it under. */
export interface Finding {
  /** The script's own heading, without the leading `--`. */
  readonly section: string;
  /** The script's own word for it: `data folder`, `profile`, `program folder`. */
  readonly what: string;
  readonly path: string;
  /** False when the script said `(absent)` — nothing there to remove. */
  readonly present: boolean;
}

/** A `[dry-run]` line that names an action rather than a path. */
export interface Note {
  readonly section: string;
  readonly message: string;
}

export interface Report {
  readonly findings: Finding[];
  readonly notes: Note[];
  /** Whatever the script could not remove. Empty on a dry run. */
  readonly failures: string[];
  /** The script's own tally, when it printed one. */
  readonly counts: { removed: number; kept: number; skipped: number; failed: number } | null;
}

const SECTION = /^--\s*(.+?)\s*$/;
const PATH_LINE = /^\[(dry-run|remove|skip|keep|fail)\]\s+(?:would remove\s+)?(.+?):\s+(.+?)$/;
const NOTE_LINE = /^\[dry-run\]\s+(would .+)$/;
const COUNTS = /^Done\.\s+removed\s+(\d+),\s+kept\s+(\d+),\s+skipped\s+(\d+),\s+failed\s+(\d+)/;

/**
 * Only these tags name something on disk. `remove`/`skip`/`keep` are the live
 * run's tags and are parsed too, so the same function reads a wipe's output —
 * otherwise the verify pass and the wipe pass would need separate parsers and
 * could disagree about what a line means.
 */
export function parseScriptOutput(stdout: string): Report {
  const findings: Finding[] = [];
  const notes: Note[] = [];
  const failures: string[] = [];
  let counts: Report['counts'] = null;
  let section = '';

  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;

    const heading = SECTION.exec(line);
    if (heading?.[1]) {
      section = heading[1];
      continue;
    }

    const tally = COUNTS.exec(line);
    if (tally) {
      counts = {
        removed: Number(tally[1]),
        kept: Number(tally[2]),
        skipped: Number(tally[3]),
        failed: Number(tally[4]),
      };
      continue;
    }

    const found = PATH_LINE.exec(line);
    if (found) {
      const [, tag, what, rest] = found;
      if (tag === 'fail') {
        failures.push(line);
        continue;
      }
      // `would remove the folder named in <pointer>, if any` matches the path
      // shape too — it has a colon and a trailing path — but it names no
      // target. It is a note, and `NOTE_LINE` below claims it.
      if (what !== undefined && rest !== undefined && !what.startsWith('would ')) {
        const absent = rest.endsWith(' (absent)');
        findings.push({
          section,
          what,
          path: absent ? rest.slice(0, -' (absent)'.length) : rest,
          present: !absent,
        });
        continue;
      }
    }

    const note = NOTE_LINE.exec(line);
    if (note?.[1]) notes.push({ section, message: note[1] });
  }

  return { findings, notes, failures, counts };
}

/** Only what is actually there — the list worth showing somebody. */
export function present(report: Report): Finding[] {
  return report.findings.filter((finding) => finding.present);
}

/**
 * The folders a backup has to copy before a wipe.
 *
 * Matched on the script's own word rather than by guessing at paths: both
 * scripts say `data folder` for the panel's own directory and `relocated data
 * folder` for one an operator moved, and those two are the only things on the
 * list that hold a company's records. A profile or a cache is Electron's and
 * is not worth a minute of copying.
 */
export function dataFolders(report: Report): Finding[] {
  return present(report).filter((finding) => finding.what.endsWith('data folder'));
}

/** Nothing of ours on this machine — the tool should say so rather than pretend to work. */
export function isClean(report: Report): boolean {
  return present(report).length === 0;
}
