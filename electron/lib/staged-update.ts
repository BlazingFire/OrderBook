/**
 * The Master's unattended install, done by a task that checks for itself
 * (1.4 R8, the owner's option B).
 *
 * **Why a task at all.** The Windows installer is per-machine and needs
 * administrator approval. At 23:00 nobody can answer a prompt, so the installer
 * registers a *scheduled task* that runs with the highest privileges of the
 * account that installed it. The Master's shell, which is not elevated, asks
 * Windows to run that task (`schtasks /Run`) and nothing more.
 *
 * **Why that is not a hole.** A task that ran "whatever is in a folder the user
 * can write" would hand every program on the PC administrator rights. This one
 * runs a fixed script from the program folder (writable only by an
 * administrator) that trusts nothing it is given:
 *
 *  1. it reads the manifest the shell staged, and **verifies its Ed25519
 *     signature itself**, against the release keys compiled into the *installed*
 *     program (`TRUSTED_RELEASE_KEYS`), never an unsigned one;
 *  2. it checks the manifest is for this panel and OS and is **newer** than the
 *     installed version, so an old signed release cannot be replayed;
 *  3. it copies the setup file into a folder only administrators can write,
 *     **hashes that copy** against the signed `sha256` and size, and runs the copy.
 *
 * Whoever can write the staged files can therefore only make the task install a
 * build the owner signed, and a newer one than is installed.
 *
 * Everything that decides is here, pure, so the suite can run it. The script
 * (`apply-staged-update.ts`) and the shell's preflight call the same functions.
 */

import { createHash, createPublicKey, verify } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';

/** The task the installer registers; the shell and the uninstaller name it. */
export const TASK_NAME = 'OrderBook Master Update';

/** The signed manifest the shell stages beside the setup file. */
export const STAGED_MANIFEST = 'manifest.json';

/** Where the installer records the folders below, in the administrator-only program folder. */
export const UPDATE_PATHS_FILE = 'paths.json';

/**
 * The folders the update task works in, **read from a file the installer wrote
 * into the program folder**, never from the environment.
 *
 * The task runs as an account whose environment (`%ProgramData%`, `%TEMP%`,
 * `NODE_OPTIONS` …) the same account's other programs can change, so a path
 * derived from it is a path an attacker can choose. `paths.json` is written once,
 * by the installer, from the Windows known-folder API, into a folder only an
 * administrator can write.
 *
 *  - `stage`: where the (unelevated) shell puts what it wants installed. Anyone
 *    may write it, so nothing in it is believed.
 *  - `work`: created by the installer, owned by Administrators with a protected
 *    ACL (administrators and SYSTEM only). The task copies the setup file here
 *    before hashing it, and runs it with `TEMP` here, so neither can be swapped.
 *  - `powershell`: the system's own `powershell.exe`, for the ACL re-check.
 */
export interface UpdatePaths {
  stage: string;
  work: string;
  powershell: string;
}

const WINDOWS_ABSOLUTE = /^[A-Za-z]:\\[^<>:"|?*\0]+$/;

/** Parse `paths.json`; `null` when anything about it is not what the installer writes. */
export function parseUpdatePaths(text: string): UpdatePaths | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const { stage, work, powershell } = raw as Record<string, unknown>;
  if (![stage, work, powershell].every((value) => typeof value === 'string' && WINDOWS_ABSOLUTE.test(value))) {
    return null;
  }
  const dirs = { stage: stage as string, work: work as string, powershell: powershell as string };
  // Two different folders under one root, and the system's own PowerShell.
  if (dirs.stage.toLowerCase() === dirs.work.toLowerCase()) return null;
  if (path.win32.dirname(dirs.stage).toLowerCase() !== path.win32.dirname(dirs.work).toLowerCase()) return null;
  if (path.win32.basename(dirs.powershell).toLowerCase() !== 'powershell.exe') return null;
  if (dirs.stage.includes('..') || dirs.work.includes('..') || dirs.powershell.includes('..')) return null;
  return dirs;
}

/** What the task tells the shell, in the (untrusted) stage folder: a hint, never an instruction. */
export const TASK_RESULT = 'result.json';

export type TaskStatus = 'checking' | 'installing' | 'refused';

/** The shell's next move after asking Windows to run the task. */
export type AfterTaskStart = 'wait' | 'quit' | 'recover';

/** How long the shell waits for the task to say anything before it brings the server back. */
export const TASK_ANSWER_MS = 90_000;

/**
 * `quit` only when the task says it is installing; `recover` (restart the server
 * that was stopped) when it refused, or said nothing for `TASK_ANSWER_MS` (the
 * account was not logged on, the task could not start, the script crashed).
 * Anything unreadable counts as saying nothing. A forged result can therefore
 * only make the shell quit early or restart its own server.
 */
export function decideAfterTaskStart(status: unknown, elapsedMs: number): AfterTaskStart {
  if (status === 'installing') return 'quit';
  if (status === 'refused') return 'recover';
  return elapsedMs >= TASK_ANSWER_MS ? 'recover' : 'wait';
}

/** The slice of `@orderbook/shared` the verification needs, passed in because the shell cannot import it at build time. */
export interface ReleaseTrust {
  canonicalManifestPayload(manifest: never): string;
  trustedKeyById(keyId: string): { publicKey: string } | undefined;
  isNewer(candidate: string, running: string): boolean;
}

/** What a staged manifest must look like, field by field. */
export interface StagedManifest {
  panel: 'master';
  platform?: string;
  version: string;
  file: string;
  sha256: string;
  sizeBytes: number;
  releasedAt?: string;
  keyId: string;
  signature: string;
}

export type StagedVerdict = { ok: true; manifest: StagedManifest } | { ok: false; reason: string };

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/**
 * Whether the signature on `manifest` was made by a key this build trusts.
 * Ed25519, the same check `release-signature.ts` makes in the server; unsigned is
 * never acceptable here, whatever `ORDERBOOK_ALLOW_UNSIGNED_RELEASES` says.
 */
export function signatureHolds(manifest: StagedManifest, trust: ReleaseTrust): boolean {
  const key = trust.trustedKeyById(manifest.keyId);
  if (!key) return false;
  try {
    return verify(
      null,
      Buffer.from(trust.canonicalManifestPayload(manifest as never), 'utf8'),
      createPublicKey({ key: Buffer.from(key.publicKey, 'base64'), format: 'der', type: 'spki' }),
      Buffer.from(manifest.signature, 'base64'),
    );
  } catch {
    return false;
  }
}

/**
 * Decide whether a staged manifest may be acted on, before the setup file is
 * looked at. Every refusal names its reason for the task's log.
 */
export function judgeStagedManifest(raw: unknown, installedVersion: string, trust: ReleaseTrust): StagedVerdict {
  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'the manifest is not an object' };
  const manifest = raw as Partial<StagedManifest>;

  if (manifest.panel !== 'master') return { ok: false, reason: 'the manifest is not for the Master Panel' };
  if (manifest.platform !== undefined && manifest.platform !== 'win32') {
    return { ok: false, reason: `the manifest is for ${String(manifest.platform)}, not Windows` };
  }
  if (!isText(manifest.version)) return { ok: false, reason: 'the manifest has no version' };
  if (!isText(manifest.file) || path.win32.basename(manifest.file) !== manifest.file || !/\.exe$/i.test(manifest.file)) {
    // A bare file name: a path in a manifest is how a task is pointed somewhere else.
    return { ok: false, reason: 'the manifest names a file that is not a bare .exe name' };
  }
  if (!isText(manifest.sha256) || !/^[0-9a-f]{64}$/i.test(manifest.sha256)) {
    return { ok: false, reason: 'the manifest has no SHA-256' };
  }
  if (typeof manifest.sizeBytes !== 'number' || !Number.isInteger(manifest.sizeBytes) || manifest.sizeBytes <= 0) {
    return { ok: false, reason: 'the manifest has no size' };
  }
  if (!isText(manifest.keyId) || !isText(manifest.signature)) {
    return { ok: false, reason: 'the manifest is not signed' };
  }

  // A manifest from before the platform field is a Windows one, and is signed as such.
  const complete = { ...manifest, platform: manifest.platform ?? 'win32' } as StagedManifest;
  if (!signatureHolds(complete, trust)) {
    return { ok: false, reason: `the signature does not verify against a trusted key (${complete.keyId})` };
  }
  if (!trust.isNewer(complete.version, installedVersion)) {
    return { ok: false, reason: `${complete.version} is not newer than the installed ${installedVersion}` };
  }
  return { ok: true, manifest: complete };
}

/** Lowercase hex SHA-256 of a file, streamed. */
export function sha256OfFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Whether the bytes about to run are the bytes the signature covers. Called on
 * the copy in the administrators-only folder, never on the staged original.
 */
export function judgeInstallerFile(
  manifest: Pick<StagedManifest, 'sha256' | 'sizeBytes'>,
  actual: { sizeBytes: number; sha256: string },
): { ok: true } | { ok: false; reason: string } {
  if (actual.sizeBytes !== manifest.sizeBytes) {
    return { ok: false, reason: `the setup file is ${actual.sizeBytes} bytes, the manifest says ${manifest.sizeBytes}` };
  }
  if (actual.sha256.toLowerCase() !== manifest.sha256.toLowerCase()) {
    return { ok: false, reason: 'the setup file does not match the signed SHA-256' };
  }
  return { ok: true };
}
