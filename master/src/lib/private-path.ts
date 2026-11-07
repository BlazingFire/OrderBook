/**
 * Cut a new secret file or folder down to this Windows account, SYSTEM and the
 * Administrators group.
 *
 * Node's file modes do nothing on Windows. The default data folder sits under the
 * person's profile and inherits a private ACL; a folder on another drive inherits
 * "everybody on this PC may read". Only ever called on something just created: an
 * install already running keeps the access it has, because another account may rely
 * on it.
 *
 * The grant runs first and inheritance is cut only if it worked, so a failure can
 * never lock anybody out. Best effort: a failure is a warning, never a failed start.
 */

import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';

import { toErrorMessage } from './errors.js';
import { createLogger } from './logger.js';

const log = createLogger('private-path');

const SYSTEM_SID = 'S-1-5-18';
const ADMINISTRATORS_SID = 'S-1-5-32-544';

function system32(tool: string): string {
  // By absolute path: never whatever PATH finds first.
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', tool);
}

function currentUserSid(): string {
  const output = execFileSync(system32('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
  });
  const sid = /S-1-[\d-]+/.exec(output)?.[0];
  if (!sid) throw new Error('whoami did not name this account');
  return sid;
}

export function keepPrivate(target: string): void {
  if (process.platform !== 'win32') return;
  try {
    const flags = statSync(target).isDirectory() ? '(OI)(CI)F' : 'F';
    const icacls = (...args: string[]): void => {
      execFileSync(system32('icacls.exe'), [target, ...args], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 10_000,
      });
    };
    icacls(
      '/grant:r',
      `*${currentUserSid()}:${flags}`,
      `*${SYSTEM_SID}:${flags}`,
      `*${ADMINISTRATORS_SID}:${flags}`,
    );
    icacls('/inheritance:r');
  } catch (error) {
    log.warn(`Could not restrict ${target}: ${toErrorMessage(error)}`);
  }
}
