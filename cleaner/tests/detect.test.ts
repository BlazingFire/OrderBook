/**
 * Reading the uninstall scripts' own plan.
 *
 * The fixtures matter more than the assertions. `linux-dry-run.txt` is real
 * output, captured from `tools/uninstall/uninstall-orderbook.sh --dry-run`
 * against a seeded footprint, with the home directory rewritten; if the script
 * changes what it prints, regenerating it is how this notices.
 * `windows-dry-run.txt` is hand-built from the `Note` calls in the `.ps1`,
 * because that script cannot run here — which is stated rather than hidden, so
 * nobody reads it as evidence the Windows path works.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { dataFolders, isClean, parseScriptOutput, present } from '../src/detect.js';

const FIXTURES = path.join(import.meta.dirname, 'fixtures');
const linux = readFileSync(path.join(FIXTURES, 'linux-dry-run.txt'), 'utf8');
const windows = readFileSync(path.join(FIXTURES, 'windows-dry-run.txt'), 'utf8');

describe('parsing a dry run', () => {
  it('tells what is there from what is not', () => {
    // The seeded footprint was exactly the two data folders; everything else
    // the script listed was absent.
    const report = parseScriptOutput(linux);

    expect(present(report).map((finding) => finding.path)).toEqual([
      '/home/pat/.config/OrderBook/master',
      '/home/pat/.config/OrderBook/office',
    ]);
    expect(report.findings.length).toBeGreaterThan(30);
  });

  it('strips the (absent) marker rather than leaving it in the path', () => {
    const report = parseScriptOutput(linux);
    for (const finding of report.findings) {
      expect(finding.path).not.toMatch(/\(absent\)$/);
    }
  });

  it('keeps each script to its own grouping', () => {
    // The shell script heads sections with a panel; PowerShell heads them with
    // a category. Normalising the two here would be a second opinion that can
    // disagree with the thing doing the removing.
    const sections = (text: string) => [
      ...new Set(parseScriptOutput(text).findings.map((finding) => finding.section)),
    ];

    expect(sections(linux)).toEqual(['OrderBook Master Panel', 'OrderBook Office Panel']);
    expect(sections(windows)).toContain('Program folders');
    expect(sections(windows)).toContain('Data');
  });

  it('carries the registry keys and firewall rules as notes, under their sections', () => {
    // These are footprint too, and the tool claims to detect config as well as
    // files — but they are not paths and a dry run cannot always say whether
    // one is there, so they are reported as what the script said it would do
    // rather than counted among the things present on disk.
    const report = parseScriptOutput(windows);
    const sections = new Set(report.notes.map((note) => note.section));

    expect(sections).toContain('Firewall');
    expect(sections).toContain('Registry');
    expect(report.notes.map((note) => note.message)).toContain(
      'would delete firewall rule OrderBook Master (TCP 4100)',
    );
  });

  it('reads Windows paths, backslashes, drive letters and spaces intact', () => {
    const report = parseScriptOutput(windows);
    const paths = present(report).map((finding) => finding.path);

    expect(paths).toContain(String.raw`C:\Program Files\OrderBook Master Panel`);
    expect(paths).toContain(String.raw`C:\Users\pat\AppData\Roaming\OrderBook\master`);
    expect(paths).toContain(String.raw`D:\OrderBookData`);
  });

  it('does not mistake an action for a path', () => {
    // "would remove the folder named in <pointer>, if any" has a colon and
    // ends in something path-shaped, but it names no target — counting it
    // would report a file that is not there as present.
    const report = parseScriptOutput(linux);

    expect(report.findings.map((finding) => finding.what)).not.toContain(
      'would remove the folder named in /home/pat/.config/OrderBook/master-location.json, if any',
    );
    expect(report.notes.some((note) => note.message.includes('would remove the folder named in'))).toBe(
      true,
    );
  });

  it('separates the data folders a backup has to copy', () => {
    // On the script's own word, not by guessing at paths: `data folder` and
    // `relocated data folder` are the only two that hold a company's records.
    expect(dataFolders(parseScriptOutput(linux)).map((finding) => finding.path)).toEqual([
      '/home/pat/.config/OrderBook/master',
      '/home/pat/.config/OrderBook/office',
    ]);

    expect(dataFolders(parseScriptOutput(windows)).map((finding) => finding.path)).toEqual([
      String.raw`C:\Users\pat\AppData\Roaming\OrderBook\master`,
      String.raw`D:\OrderBookData`,
    ]);
  });

  it('does not count a profile or a cache as data worth backing up', () => {
    const backed = dataFolders(parseScriptOutput(windows)).map((finding) => finding.what);
    expect(backed).not.toContain('profile');
    expect(backed).not.toContain('updater cache');
    expect(backed).not.toContain('program folder');
  });
});

describe('a machine with nothing on it', () => {
  it('reports clean rather than pretending to have work to do', () => {
    const nothing = [
      'OrderBook uninstall  (DRY RUN - nothing will be changed)',
      '-- OrderBook Master Panel',
      '[dry-run] would remove data folder: /home/pat/.config/OrderBook/master (absent)',
      'Dry run complete. Nothing was changed.',
    ].join('\n');

    const report = parseScriptOutput(nothing);
    expect(isClean(report)).toBe(true);
    expect(report.findings).toHaveLength(1);
  });

  it('is not clean the moment one thing is present', () => {
    expect(isClean(parseScriptOutput(linux))).toBe(false);
  });
});

describe('parsing a real run rather than a dry one', () => {
  it('reads the tally and the failures', () => {
    // One parser for both passes. Two would be free to disagree about what a
    // line means, and the verify pass exists precisely to be trusted.
    const done = [
      '-- OrderBook Master Panel',
      '[remove] data folder: /home/pat/.config/OrderBook/master',
      '[skip] profile not present: /home/pat/.config/OrderBook Master Panel',
      '[fail] could not remove program folder: /opt/OrderBook Master Panel',
      'Done. removed 1, kept 0, skipped 1, failed 1',
    ].join('\n');

    const report = parseScriptOutput(done);
    expect(report.counts).toEqual({ removed: 1, kept: 0, skipped: 1, failed: 1 });
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toContain('/opt/OrderBook Master Panel');
  });

  it('has no counts when the script printed none', () => {
    expect(parseScriptOutput(linux).counts).toBeNull();
  });
});
