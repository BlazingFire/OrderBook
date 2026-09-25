/**
 * The shell points people at the log it is writing, not at one it might open.
 *
 * `logPath()` in `shell.ts` is worked out from the data folder, read fresh from
 * the pointer on every call — right for opening the log at launch, and wrong
 * for every later "where is the log": the shell opens it once, and a storage
 * move rewrites the pointer while the app runs (an Office Panel's move from the
 * Master or its storage card, the Master's first-run chooser). After one, the
 * crash dialog, Help → Open log folder, the bridge's `getShellSettings` and
 * `openLogFolder`, and the server's `/api/health` after a crash-restart all
 * named a file in the new folder that nothing was writing to, while the lines
 * that mattered kept going to the old one.
 *
 * `shell.ts` imports `electron`, so it cannot run under this suite (see
 * `vitest.config.ts`). This reads it instead, like the uninstall tests read the
 * scripts the shell hands to the OS: the path a fresh start would use may be
 * asked for only by the call that opens the log, and by `openLogPath()` for the
 * moment before there is one.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const shell = readFileSync(path.resolve(import.meta.dirname, '..', 'shell.ts'), 'utf8');

/** Lines of code, not of comment, that ask where a log opened now would go. */
const freshLogPathCalls = shell
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => !line.startsWith('*') && !line.startsWith('//'))
  .filter((line) => /\blogPath\(\)/.test(line));

describe('the shell’s log', () => {
  it('is opened at the path a fresh start would use', () => {
    expect(freshLogPathCalls).toContainEqual(
      expect.stringMatching(/^log = openLogFile\(logPath\(\),/),
    );
  });

  it('is named from where it was opened everywhere else', () => {
    // A third call is a "where is the log" answered from the pointer, which a
    // storage move has made wrong until the next launch.
    expect(freshLogPathCalls).toHaveLength(2);
    expect(freshLogPathCalls).toContainEqual(
      expect.stringMatching(/^const openLogPath = \(\): string => log\?\.path \?\? logPath\(\);$/),
    );
  });
});
