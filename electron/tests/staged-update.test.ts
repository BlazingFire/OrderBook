import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { canonicalManifestPayload, isNewer } from '@orderbook/shared';
import { afterAll, describe, expect, it } from 'vitest';

import {
  TASK_NAME,
  judgeInstallerFile,
  judgeStagedManifest,
  signatureHolds,
  TASK_ANSWER_MS,
  decideAfterTaskStart,
  systemModulePath,
  taskChildEnv,
  parseUpdatePaths,
  type ReleaseTrust,
  type StagedManifest,
} from '../lib/staged-update.js';
import { planInstallerLaunch } from '../lib/update-launch.js';

const repo = path.resolve(import.meta.dirname, '..', '..');
const read = (file: string): string => readFileSync(path.join(repo, file), 'utf8');

/**
 * This process's environment with some variables set, **whatever case their names have**:
 * Windows names are case-insensitive and vitest hands them over upper-cased (`PSMODULEPATH`),
 * so a plain spread plus `PSModulePath: x` would make two entries and the child could see either.
 */
function withEnv(overrides: Record<string, string>): Record<string, string | undefined> {
  const names = new Set(Object.keys(overrides).map((name) => name.toLowerCase()));
  const kept = Object.fromEntries(Object.entries(process.env).filter(([name]) => !names.has(name.toLowerCase())));
  return { ...kept, ...overrides };
}

const owner = generateKeyPairSync('ed25519');
const stranger = generateKeyPairSync('ed25519');
const spki = (key: KeyObject): string => key.export({ type: 'spki', format: 'der' }).toString('base64');

/** What the installed program trusts: only the owner's key. */
const trust: ReleaseTrust = {
  canonicalManifestPayload: canonicalManifestPayload as ReleaseTrust['canonicalManifestPayload'],
  trustedKeyById: (id) => (id === 'owner-key' ? { publicKey: spki(owner.publicKey) } : undefined),
  isNewer,
};

const SHA = 'a'.repeat(64);

function signed(
  changes: Partial<StagedManifest> = {},
  signer: KeyObject = owner.privateKey,
  keyId = 'owner-key',
): StagedManifest {
  const base = {
    panel: 'master',
    platform: 'win32',
    version: '1.3.0',
    file: 'OrderBook-Master-1.3.0-Setup.exe',
    sizeBytes: 150_000_000,
    sha256: SHA,
    releasedAt: '2026-10-03T00:00:00.000Z',
    ...changes,
  } as StagedManifest;
  return {
    ...base,
    keyId,
    signature: sign(null, Buffer.from(canonicalManifestPayload(base as never), 'utf8'), signer).toString('base64'),
  };
}

describe('judgeStagedManifest: what the task will believe', () => {
  it('accepts a manifest the owner signed, for a newer version', () => {
    const verdict = judgeStagedManifest(signed(), '1.2.5', trust);
    expect(verdict.ok).toBe(true);
  });

  it('reads a manifest with no platform field as a Windows one, as it was signed', () => {
    const { platform: _platform, ...older } = signed();
    // Signed with the field absent being the default, as `readManifest` normalises it.
    const body = { ...older, platform: 'win32' } as StagedManifest;
    const resigned = {
      ...body,
      signature: sign(null, Buffer.from(canonicalManifestPayload(body as never), 'utf8'), owner.privateKey).toString('base64'),
    };
    const { platform: _p, ...withoutField } = resigned;
    expect(judgeStagedManifest(withoutField, '1.2.5', trust).ok).toBe(true);
  });

  it('refuses an unsigned manifest, even though the server could be told to allow one', () => {
    const { signature: _s, keyId: _k, ...unsigned } = signed();
    expect(judgeStagedManifest(unsigned, '1.2.5', trust)).toMatchObject({ ok: false, reason: expect.stringContaining('not signed') });
  });

  it('refuses a manifest signed by a key the installed program does not carry', () => {
    const verdict = judgeStagedManifest(signed({}, stranger.privateKey, 'owner-key'), '1.2.5', trust);
    expect(verdict).toMatchObject({ ok: false, reason: expect.stringContaining('signature') });
    expect(judgeStagedManifest(signed({}, owner.privateKey, 'unknown-key'), '1.2.5', trust).ok).toBe(false);
  });

  it('refuses a manifest changed after it was signed, in any signed field', () => {
    for (const change of [{ sha256: 'b'.repeat(64) }, { file: 'OrderBook-Master-9.9.9-Setup.exe' }, { version: '9.9.9' }, { sizeBytes: 1 }]) {
      const tampered = { ...signed(), ...change };
      expect(judgeStagedManifest(tampered, '1.2.5', trust).ok, JSON.stringify(change)).toBe(false);
    }
  });

  it('refuses an older or equal version, so an old signed release cannot be replayed', () => {
    expect(judgeStagedManifest(signed({ version: '1.2.5' }), '1.2.5', trust)).toMatchObject({ ok: false, reason: expect.stringContaining('not newer') });
    expect(judgeStagedManifest(signed({ version: '1.2.0' }), '1.2.5', trust).ok).toBe(false);
  });

  it('refuses a manifest for the Office Panel or another operating system', () => {
    expect(judgeStagedManifest(signed({ panel: 'office' as never }), '1.2.5', trust).ok).toBe(false);
    expect(judgeStagedManifest(signed({ platform: 'darwin' }), '1.2.5', trust).ok).toBe(false);
  });

  it('refuses a file name that is a path or not a setup program', () => {
    for (const file of ['..\\..\\Windows\\System32\\cmd.exe', 'C:\\x\\setup.exe', 'sub\\setup.exe', 'setup.msi', 'setup', '']) {
      expect(judgeStagedManifest(signed({ file }), '1.2.5', trust).ok, file).toBe(false);
    }
  });

  it('refuses a missing size or a malformed digest', () => {
    expect(judgeStagedManifest(signed({ sizeBytes: 0 }), '1.2.5', trust).ok).toBe(false);
    expect(judgeStagedManifest(signed({ sha256: 'nothex' }), '1.2.5', trust).ok).toBe(false);
  });

  it('refuses things that are not manifests at all', () => {
    for (const raw of [null, 'text', 42, []]) expect(judgeStagedManifest(raw, '1.2.5', trust).ok).toBe(false);
  });

  it('signatureHolds is false rather than a throw for a garbage signature', () => {
    expect(signatureHolds({ ...signed(), signature: '!!!' }, trust)).toBe(false);
  });
});

describe('judgeInstallerFile: the bytes that are about to run', () => {
  it('accepts a copy with the signed size and digest, whatever the case of the digest', () => {
    expect(judgeInstallerFile({ sha256: SHA.toUpperCase(), sizeBytes: 10 }, { sizeBytes: 10, sha256: SHA })).toEqual({ ok: true });
  });

  it('refuses another size, and another digest', () => {
    expect(judgeInstallerFile({ sha256: SHA, sizeBytes: 10 }, { sizeBytes: 11, sha256: SHA }).ok).toBe(false);
    expect(judgeInstallerFile({ sha256: SHA, sizeBytes: 10 }, { sizeBytes: 10, sha256: 'b'.repeat(64) }).ok).toBe(false);
  });
});

describe('parseUpdatePaths: where the task works, from the installer and not the environment', () => {
  const good = {
    stage: 'C:\\ProgramData\\OrderBook\\staged-update',
    work: 'C:\\ProgramData\\OrderBook\\elevated',
    powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  };

  it('reads what the installer wrote', () => {
    expect(parseUpdatePaths(JSON.stringify(good))).toEqual(good);
  });

  it('refuses anything the installer would not have written', () => {
    const cases: Array<[string, unknown]> = [
      ['relative stage', { ...good, stage: 'staged-update' }],
      ['UNC work', { ...good, work: '\\\\evil\\share\\elevated' }],
      ['dot-dot', { ...good, work: 'C:\\ProgramData\\OrderBook\\..\\elevated' }],
      ['same folder twice', { ...good, work: good.stage }],
      ['different parents', { ...good, work: 'D:\\Other\\elevated' }],
      ['not the system powershell', { ...good, powershell: 'C:\\Users\\x\\powershell.exe.bat' }],
      ['another program', { ...good, powershell: 'C:\\Windows\\System32\\cmd.exe' }],
      ['missing key', { stage: good.stage, work: good.work }],
      ['numbers', { stage: 1, work: 2, powershell: 3 }],
    ];
    for (const [name, value] of cases) expect(parseUpdatePaths(JSON.stringify(value)), name).toBeNull();
    for (const text of ['', 'not json', 'null', '[]', '"x"']) expect(parseUpdatePaths(text), text).toBeNull();
  });
});

describe('decideAfterTaskStart: bringing the server back when the task refuses', () => {
  it('quits only when the task says it is installing', () => {
    expect(decideAfterTaskStart('installing', 0)).toBe('quit');
    expect(decideAfterTaskStart('installing', TASK_ANSWER_MS * 2)).toBe('quit');
  });

  it('recovers at once when the task refused', () => {
    expect(decideAfterTaskStart('refused', 0)).toBe('recover');
  });

  it('waits while it is still checking, then recovers if it never answers', () => {
    expect(decideAfterTaskStart('checking', 1_000)).toBe('wait');
    expect(decideAfterTaskStart(undefined, 1_000)).toBe('wait');
    expect(decideAfterTaskStart(undefined, TASK_ANSWER_MS - 1)).toBe('wait');
    // The account was not logged on, the task crashed, the folder failed its check: silence.
    expect(decideAfterTaskStart(undefined, TASK_ANSWER_MS)).toBe('recover');
    expect(decideAfterTaskStart('checking', TASK_ANSWER_MS)).toBe('recover');
  });

  it('reads anything odd as silence, never as permission to quit', () => {
    for (const odd of ['INSTALLING', 42, {}, null, true]) {
      expect(decideAfterTaskStart(odd, 1_000), String(odd)).toBe('wait');
      expect(decideAfterTaskStart(odd, TASK_ANSWER_MS)).toBe('recover');
    }
  });
});

describe('the task in the launch plan', () => {
  const base = { platform: 'win32' as const, file: 'C:\\x\\setup.exe', unattended: true, elevated: false };

  it('asks Windows to run the update task when nobody can approve a prompt and the task is registered', () => {
    expect(planInstallerLaunch({ ...base, taskReady: true })).toEqual({
      how: 'task',
      command: 'schtasks.exe',
      args: ['/Run', '/TN', TASK_NAME],
    });
  });

  it('declines, and starts nothing, when the task is not registered', () => {
    expect(planInstallerLaunch({ ...base, taskReady: false })).toEqual({ how: 'needs-approval' });
    expect(planInstallerLaunch(base)).toEqual({ how: 'needs-approval' });
  });

  it('does not use the task when somebody is there, or when already elevated', () => {
    expect(planInstallerLaunch({ ...base, unattended: false, taskReady: true }).how).toBe('elevate');
    expect(planInstallerLaunch({ ...base, elevated: true, taskReady: true }).how).toBe('spawn');
  });
});

describe('the pieces fit together', () => {
  const script = read('electron/apply-staged-update.ts');
  const nsis = read('master/installer/installer.nsh');
  const cmd = read('master/installer/apply-update/apply-update.cmd');
  const ps1 = read('master/installer/apply-update/update-dirs.ps1');
  const builders = ['master/electron-builder.yml', 'office/electron-builder.yml', 'office/electron-builder.legacy.yml'];
  const shell = read('electron/shell.ts');

  it('the script verifies the manifest, copies, then hashes the copy, then runs the copy', () => {
    const order = ['judgeStagedManifest(', 'copyFile(', 'judgeInstallerFile(', "spawn(copy, ['/S', '--force-run']"].map((needle) =>
      script.indexOf(needle),
    );
    expect(order.every((at) => at > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Never the staged original.
    expect(script).not.toMatch(/spawn\(path\.join\(stage/);
  });

  it('the script takes every path from paths.json and nothing from the environment', () => {
    expect(script).toContain('UPDATE_PATHS_FILE');
    expect(script).toContain('parseUpdatePaths(');
    expect(script).not.toContain('stagedUpdateDirs');
    // Nothing at all comes from process.env: the children's environment is built from nothing.
    expect(script).not.toContain('process.env');
    // Every child's environment is built from nothing (taskChildEnv), not from the account's.
    expect(script).toMatch(/env: taskChildEnv\(paths, \{ PSModulePath: systemModulePath\(powershell\) \}\)/);
    expect(script).toMatch(/env: taskChildEnv\(paths, \{ TEMP: temp, TMP: temp \}\)/);
    expect(shell).not.toContain('stagedUpdateDirs');
    expect(shell).toContain('readUpdatePaths()');
  });

  it('the setup is run with TEMP and TMP in the administrators-only work folder', () => {
    expect(script).toMatch(/const temp = path\.join\(work, 'tmp'\)/);
    expect(script).toMatch(/TEMP: temp, TMP: temp/);
  });

  it('the script has PowerShell re-check the work folder before anything is written to it, and writes nothing if that fails', () => {
    const check = script.indexOf("'update-dirs.ps1'");
    const firstWrite = script.indexOf("await tell('checking')");
    expect(check).toBeGreaterThan(-1);
    expect(firstWrite).toBeGreaterThan(check);
    expect(script).toMatch(/if \(check\.code !== 0\) \{[\s\S]{0,400}return 2;\s*\}/);
    // The check-failed branch must not write through the folder that failed it.
    const branch = script.slice(script.indexOf('if (check.code !== 0)'), script.indexOf("await say('Nightly update task started')"));
    expect(branch).not.toMatch(/tell\(|say\(|writeFile|appendFile|refuse\(/);
  });

  it('the installer hands the folders to update-dirs.ps1 and registers the task only if it succeeds', () => {
    expect(nsis).toContain('update-dirs.ps1');
    expect(nsis).toContain('-Mode Install -InstallDir $$env:OB_INSTDIR');
    // The system's own PowerShell, by absolute path, not whatever PATH finds.
    expect(read('tools/nsis/verified-powershell.nsh')).toContain('"$SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe"');
    const run = nsis.indexOf('-Mode Install');
    const register = nsis.indexOf('/Create /F /TN "OrderBook Master Update"');
    const guard = nsis.indexOf('${If} $R1 == "0"', run);
    expect(register).toBeGreaterThan(guard);
    expect(guard).toBeGreaterThan(run);
    expect(nsis).toContain('/RL HIGHEST');
    expect(nsis).toContain('apply-update\\apply-update.cmd');
    // And an earlier version's task goes when the folders cannot be made trustworthy.
    expect(nsis).toMatch(/\$\{Else\}[\s\S]{0,300}\/Delete \/F \/TN "OrderBook Master Update"/);
  });

  it('the installer no longer reuses %ProgramData%\\OrderBook with a plain icacls (the squatting hole)', () => {
    expect(nsis).not.toContain('ReadEnvStr $R0 ProgramData\n  ${If}');
    expect(nsis).not.toMatch(/CreateDirectory "\$R0\\OrderBook\\(staged-update|elevated)"/);
    expect(nsis).not.toContain('/grant *S-1-5-32-545:(OI)(CI)M');
    expect(nsis).not.toMatch(/icacls "\$R0\\OrderBook\\elevated" \/inheritance:r/);
  });

  it('update-dirs.ps1 takes ownership, removes links, moves a foreign folder aside, and trusts no environment variable', () => {
    for (const piece of [
      'Clear-Squatter',
      '[System.IO.Directory]::Delete($Target, $false)',
      '.untrusted-',
      '/setowner',
      'SetAccessRuleProtection($true, $false)',
      'GetFolderPath(\'CommonApplicationData\')',
      '[Environment]::SystemDirectory',
      'is a link',
      'is owned by',
      'lets ',
    ]) {
      expect(ps1, piece).toContain(piece);
    }
    // Paths come from the known-folder API, never from $env:.
    // The one use of $env: is the PSModulePath pin, which takes the account's value away.
    expect(ps1.match(/\$env:/gi)?.length).toBe(1);
    expect(ps1).toContain("$env:PSModulePath = $PSHOME + '\\Modules'");
    // Every icacls call that could meet a link says /L.
    for (const line of ps1.split('\n').filter((l) => l.includes('& $Icacls'))) expect(line, line).toContain('/L');
  });

  it('the launcher clears every NODE_* and ELECTRON_* variable, then runs the script by a path from its own location', () => {
    expect(cmd).toContain("for /f \"delims==\" %%A in ('set NODE_ 2^>nul') do set \"%%A=\"");
    expect(cmd).toContain("for /f \"delims==\" %%A in ('set ELECTRON_ 2^>nul') do set \"%%A=\"");
    expect(cmd).toContain('set "NODE_OPTIONS="');
    expect(cmd.indexOf('set ELECTRON_')).toBeLessThan(cmd.indexOf('set "ELECTRON_RUN_AS_NODE=1"'));
    // resources\apply-update\ -> the program folder is two levels up.
    expect(cmd).toContain('"%~dp0..\\..\\OrderBook Master Panel.exe" "%~dp0apply-staged-update.js"');
  });

  it('the uninstaller removes the task, but not during an update that may have been started by it', () => {
    const removal = nsis.indexOf('/Delete /F /TN "OrderBook Master Update"', nsis.indexOf('customUnInstall'));
    const guard = nsis.lastIndexOf('${IfNot} ${isUpdated}', removal);
    expect(removal).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(-1);
    expect(nsis.slice(guard, removal)).not.toContain('${EndIf}');
  });

  it('the package ships the script, its helper, the launcher and the PowerShell script as real files', () => {
    const builder = read('master/electron-builder.yml');
    for (const piece of ['apply-staged-update.js', 'lib/staged-update.js', 'apply-update/package.json', 'apply-update.cmd', 'update-dirs.ps1']) {
      expect(builder, piece).toContain(piece);
    }
  });

  it('every Windows build switches the NODE_OPTIONS and --inspect fuses off after packing', () => {
    for (const file of builders) expect(read(file), file).toMatch(/^afterPack: \.\.\/tools\/flip-fuses\.cjs$/m);
  });

  it('the shell stages and checks before it stops the server, and waits for the task before it quits', () => {
    const stage = shell.indexOf('stageForUpdateTask(verdict.path, prepared)');
    const stop = shell.indexOf('await stopServer();', stage);
    expect(stage).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(stage);
    const run = shell.indexOf("plan.how === 'task'", stop);
    const wait = shell.indexOf('waitForUpdateTask(startedAt)', run);
    const quit = shell.indexOf('app.quit();', wait);
    expect(wait).toBeGreaterThan(run);
    expect(quit).toBeGreaterThan(wait);
    expect(shell).toMatch(/=== 'recover'\) \{\s*throw new Error/);
  });
});

describe('the fuses', () => {
  const { flipFuses, readFuses, SENTINEL } = createRequire(import.meta.url)('../../tools/flip-fuses.cjs') as {
    flipFuses: (buffer: Buffer, indexes?: Record<number, string>) => string[];
    readFuses: (buffer: Buffer) => Record<string, boolean | null>;
    SENTINEL: Buffer;
  };

  /** A binary-shaped buffer: padding, the sentinel, version 1, the wire length, and the fuse bytes. */
  const exe = (wire: string, pad = 64): Buffer =>
    Buffer.concat([Buffer.alloc(pad, 0x90), SENTINEL, Buffer.from([1, wire.length]), Buffer.from(wire, 'latin1'), Buffer.alloc(pad, 0x90)]);

  it('turns NODE_OPTIONS and --inspect off and leaves the rest as they were, RunAsNode included', () => {
    const bytes = exe('11111r10'); // RunAsNode on, ..., NodeOptions on, Inspect on, ...
    expect(flipFuses(bytes)).toEqual(['EnableNodeOptionsEnvironmentVariable', 'EnableNodeCliInspectArguments']);
    expect(bytes.subarray(bytes.indexOf(SENTINEL) + SENTINEL.length + 2).toString('latin1').slice(0, 8)).toBe('11001r10');
    expect(readFuses(bytes)).toEqual({ EnableNodeOptionsEnvironmentVariable: false, EnableNodeCliInspectArguments: false });
  });

  it('is a no-op on fuses that are already off, and says nothing was switched', () => {
    expect(flipFuses(exe('10001111'))).toEqual([]);
  });

  it('refuses a binary it cannot read, rather than leaving a fuse on without saying', () => {
    expect(() => flipFuses(Buffer.alloc(100))).toThrow(/sentinel was not found/);
    expect(() => flipFuses(Buffer.concat([exe('11111111'), exe('11111111')]))).toThrow(/twice/);
    expect(() => flipFuses(exe('11'))).toThrow(/fuse wire has 2 fuses/);
    const odd = exe('1111');
    odd[odd.indexOf(SENTINEL) + SENTINEL.length] = 9;
    expect(() => flipFuses(odd)).toThrow(/version 9/);
  });

  it('works on the Electron this repository ships', () => {
    const electron = path.join(repo, 'node_modules', 'electron', 'dist', 'electron.exe');
    if (!existsSync(electron)) return;
    const bytes = readFileSync(electron);
    expect(readFuses(bytes)).toEqual({ EnableNodeOptionsEnvironmentVariable: true, EnableNodeCliInspectArguments: true });
    flipFuses(bytes);
    expect(readFuses(bytes)).toEqual({ EnableNodeOptionsEnvironmentVariable: false, EnableNodeCliInspectArguments: false });
  });
});

/**
 * The folder rules, run for real (Windows only): the same PowerShell the task runs
 * to re-check its folders. Elevated pieces (taking ownership) cannot run in a
 * test, so what is exercised is the *refusing* half, which is the half that stops
 * a squatter.
 */
describe.skipIf(process.platform !== 'win32')('update-dirs.ps1 -Mode Check, run for real', () => {
  const script = path.join(repo, 'master', 'installer', 'apply-update', 'update-dirs.ps1');
  const root = mkdtempSync(path.join(os.tmpdir(), 'ob-ps-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function check(target: string): { code: number; output: string } {
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Mode', 'Check', '-Path', target],
      { encoding: 'utf8', windowsHide: true },
    );
    return { code: result.status ?? -1, output: String(result.stdout).trim() };
  }

  it('accepts a folder Windows itself owns and protects', () => {
    expect(check(process.env.SystemRoot ?? 'C:\\Windows')).toEqual({ code: 0, output: '' });
  });

  it('refuses a folder the current user owns and can write: that is what a squatter would have made', () => {
    const squatted = path.join(root, 'OrderBook');
    mkdirSync(squatted);
    const { code, output } = check(squatted);
    expect(code).toBe(1);
    expect(output).toMatch(/is owned by|lets /);
  });

  it('refuses a folder whose ACL is perfect but whose owner is a standard user: an owner can always rewrite the ACL', () => {
    const folder = path.join(root, 'owned-by-user');
    mkdirSync(folder);
    // Only Administrators and SYSTEM listed, inheritance cut: no weak entry at all.
    const acl = spawnSync('icacls.exe', [folder, '/inheritance:r', '/grant:r', '*S-1-5-32-544:(OI)(CI)F', '*S-1-5-18:(OI)(CI)F'], { windowsHide: true });
    expect(acl.status).toBe(0);
    const { code, output } = check(folder);
    expect(code).toBe(1);
    expect(output).toContain('is owned by');
    // Give it back so the temp folder can be removed.
    spawnSync('icacls.exe', [folder, '/reset'], { windowsHide: true });
  });

  it('refuses a junction, even to a perfectly good folder, so a write cannot be steered through it', () => {
    const link = path.join(root, 'junction');
    symlinkSync(process.env.SystemRoot ?? 'C:\\Windows', link, 'junction');
    const { code, output } = check(link);
    expect(code).toBe(1);
    expect(output).toContain('is a link');
  });

  it('refuses a folder reached through a link in any ancestor', () => {
    const link = path.join(root, 'junction');
    if (!existsSync(link)) symlinkSync(process.env.SystemRoot ?? 'C:\\Windows', link, 'junction');
    const { code, output } = check(path.join(link, 'System32'));
    expect(code).toBe(1);
    expect(output).toContain('is a link');
  });

  it('refuses a folder that does not exist rather than passing it', () => {
    expect(check(path.join(root, 'nothing-here')).code).toBe(1);
  });
});

describe('the installer scripts are verified, and PowerShell cannot be steered by the user (CH1 second review)', () => {
  const macro = read('tools/nsis/verified-powershell.nsh');
  const masterNsis = read('master/installer/installer.nsh');
  const officeNsis = read('office/installer/installer.nsh');
  const ps1 = read('master/installer/apply-update/update-dirs.ps1');
  const apply = read('electron/apply-staged-update.ts');
  const { bakeScriptHashes } = createRequire(import.meta.url)('../../tools/bake-script-hashes.cjs') as {
    bakeScriptHashes: (installerDir: string) => { target: string; lines: string[] };
  };
  const sha = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
  const SYSTEM_ROOT = process.env.SystemRoot ?? 'C:\\Windows';

  /** The macro's command line, with NSIS's `$$` resolved and its placeholders filled. */
  function commandFor(hash: string, args: string, fallthrough: string): string {
    const line = macro.split('\n').find((l) => l.includes('-Command "$$env:PSModulePath')) ?? '';
    const command = /-Command "(.*)"`\s*$/.exec(line)?.[1] ?? '';
    expect(command).not.toBe('');
    return command
      .replaceAll('$$', '$')
      .replace('${SHA256}', hash)
      .replace('${ARGUMENTS}', args)
      .replace('${FALLTHROUGH}', fallthrough);
  }

  function runBootstrap(
    scriptFile: string,
    hash: string,
    args: string,
    fallthrough: string,
    env: Record<string, string> = {},
  ): { code: number; output: string } {
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', commandFor(hash, args, fallthrough)],
      { windowsHide: true, encoding: 'utf8', env: withEnv({ OB_SCRIPT: scriptFile, ...env }) },
    );
    return { code: result.status ?? -1, output: String(result.stdout).trim() };
  }

  it('every program the installers run elevated is named by its System32 path, netsh included', () => {
    for (const [name, text] of [['master', masterNsis], ['office', officeNsis], ['macro', macro]] as const) {
      for (const line of text.split('\n').filter((l) => /^\s*nsExec::/.test(l))) {
        expect(line, `${name}: ${line}`).toMatch(/\$SYSDIR\\/);
      }
    }
    expect(masterNsis).not.toMatch(/nsExec::Exec 'netsh/);
    expect(masterNsis).not.toMatch(/nsExec::Exec 'schtasks/);
    expect(masterNsis).not.toMatch(/powershell\.exe -NoProfile/);
    expect(officeNsis).not.toMatch(/powershell\.exe -NoProfile/);
    expect(masterNsis).toContain('"$SYSDIR\\netsh.exe" advfirewall firewall add rule');
    expect(masterNsis).toContain('"$SYSDIR\\netsh.exe" advfirewall firewall delete rule');
  });

  it("the task's command is cmd.exe by absolute path, with the script quoted for cmd /c", () => {
    expect(masterNsis).toContain('/TR "\\"$SYSDIR\\cmd.exe\\" /c \\"\\"$INSTDIR\\resources\\apply-update\\apply-update.cmd\\"\\""');
  });

  it('update-dirs.ps1 runs the system icacls by absolute path, always with /L', () => {
    expect(ps1).toContain("$Icacls = Join-Path ([Environment]::SystemDirectory) 'icacls.exe'");
    expect(ps1).not.toMatch(/& icacls\.exe/);
    const calls = ps1.split('\n').filter((line) => line.includes('& $Icacls'));
    expect(calls.length).toBeGreaterThan(1);
    for (const line of calls) expect(line, line).toContain('/L');
  });

  it('PSModulePath is the first thing the verifying command does, before any cmdlet', () => {
    const line = macro.split('\n').find((l) => l.includes('-Command "$$env:PSModulePath')) ?? '';
    const command = /-Command "(.*)"`\s*$/.exec(line)?.[1] ?? '';
    expect(command.startsWith("$$env:PSModulePath=$$PSHOME+'\\Modules';")).toBe(true);
    // Nothing before the check is a cmdlet: only .NET, variables and keywords.
    const beforeRun = command.slice(0, command.indexOf('& $$s'));
    expect(beforeRun).not.toMatch(/\b(Join-Path|Get-[A-Z]\w+|Set-[A-Z]\w+|Test-Path|ForEach-Object|Where-Object|Write-\w+)\b/);
  });

  it('update-dirs.ps1 pins PSModulePath before its first cmdlet, and the task starts it with the system module path only', () => {
    const pin = ps1.indexOf("$env:PSModulePath = $PSHOME + '\\Modules'");
    expect(pin).toBeGreaterThan(-1);
    expect(pin).toBeLessThan(ps1.indexOf('Set-StrictMode'));
    expect(systemModulePath('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')).toBe(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
    );
    // Nothing but comments, blank lines and the param block runs before the pin.
    const header = ps1.slice(0, pin).split('\n').filter((line) => line.trim() !== '' && !line.trim().startsWith('#'));
    expect(header.join(' ')).toMatch(/^\[CmdletBinding\(\)\] param\([\s\S]*\)$/);
    expect(header.join(' ')).not.toMatch(/\b(Join-Path|Get-\w+|Set-\w+|Test-\w+)\b/);
    expect(apply).toContain('PSModulePath: systemModulePath(powershell)');
    // Not appended to the user's: replaced.
    expect(apply).not.toMatch(/PSModulePath: `?\$\{?process\.env\.PSModulePath/);
  });

  describe.skipIf(process.platform !== 'win32')('run for real: the module hijack the reviewer proved', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ob-ps-hijack-'));
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    /** A real user's PSModulePath: their own writable folder first, then the system's. */
    const userModulePath = (modules: string): string => `${modules};${SYSTEM_ROOT}\\System32\\WindowsPowerShell\\v1.0\\Modules`;

    /**
     * A user module folder with a planted `Microsoft.PowerShell.Archive` that drops a marker when
     * it loads. (The core modules are preloaded from the system folder by path; the others, like
     * this one, are found through PSModulePath on first use, which is where the user's own
     * writable folder comes first.)
     */
    function plantedModules(name: string): { modules: string; marker: string } {
      const modules = path.join(root, name, 'Modules');
      const folder = path.join(modules, 'Microsoft.PowerShell.Archive');
      const marker = path.join(root, name, 'LOADED.txt');
      mkdirSync(folder, { recursive: true });
      writeFileSync(
        path.join(folder, 'Microsoft.PowerShell.Archive.psm1'),
        `Set-Content -LiteralPath '${marker}' -Value 'planted module ran'
function Compress-Archive { }
Export-ModuleMember -Function Compress-Archive`,
      );
      return { modules, marker };
    }

    /** A command that makes PowerShell look for that module. */
    const TRIGGER = 'try { Compress-Archive -Path nothing -DestinationPath nowhere } catch { }';

    it('the attack works against an unpinned PowerShell here (so the next tests mean something)', () => {
      const { modules, marker } = plantedModules('control');
      spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', TRIGGER], {
        windowsHide: true,
        env: withEnv({ PSModulePath: userModulePath(modules) }),
      });
      expect(existsSync(marker)).toBe(true);
    });

    it('the installer bootstrap loads nothing from the user module folder, and still runs the script', () => {
      const { modules, marker } = plantedModules('bootstrap');
      const script = path.join(root, 'ok.ps1');
      // A script that uses cmdlets, as update-dirs.ps1 does.
      writeFileSync(script, `param([string]$Mode)\n${TRIGGER}\nexit 0\n`);
      const result = runBootstrap(script, sha(readFileSync(script)), '-Mode Install', '1', { PSModulePath: userModulePath(modules) });
      expect(result.code).toBe(0);
      expect(existsSync(marker)).toBe(false);
    });

    it('a script that fails to bind is a failure exit, never a success that registers the task', () => {
      const script = path.join(root, 'binding.ps1');
      writeFileSync(script, 'param([Parameter(Mandatory = $true)][string]$Required)\nexit 0\n');
      // An unknown parameter is a binding error: the Install call falls through to exit 1.
      expect(runBootstrap(script, sha(readFileSync(script)), '-Nope 1', '1').code).toBe(1);
      // A script that throws inside the call is caught too.
      const throws = path.join(root, 'throws.ps1');
      writeFileSync(throws, "$ErrorActionPreference = 'Stop'\nthrow 'boom'\n");
      expect(runBootstrap(throws, sha(readFileSync(throws)), '', '1').code).toBe(1);
      // The sweep, which succeeds by returning, falls through to 0.
      const sweep = path.join(root, 'sweep.ps1');
      writeFileSync(sweep, 'Write-Output "swept"\n');
      expect(runBootstrap(sweep, sha(readFileSync(sweep)), '', '0').code).toBe(0);
    });

    it('a path with a dollar sign, a quote or a backtick reaches the script as data and runs nothing', () => {
      const out = path.join(root, 'received.txt');
      const script = path.join(root, 'echo.ps1');
      writeFileSync(script, `param($Mode, $InstallDir)\n[IO.File]::WriteAllText('${out}', $InstallDir)\nexit 0\n`);
      const nasty = `C:\\Program Files\\it's $(Set-Content '${path.join(root, 'EVIL.txt')}' 1) \`n $env:SystemRoot`;
      const result = runBootstrap(script, sha(readFileSync(script)), '-Mode Install -InstallDir $$env:OB_INSTDIR'.replaceAll('$$', '$'), '1', {
        OB_INSTDIR: nasty,
      });
      expect(result.code).toBe(0);
      expect(readFileSync(out, 'utf8')).toBe(nasty);
      expect(existsSync(path.join(root, 'EVIL.txt'))).toBe(false);
    });

    it('a script swapped for another is refused with exit 9 and nothing runs (install and uninstall alike)', () => {
      const real = Buffer.from('exit 0\n');
      const swapped = path.join(root, 'swapped.ps1');
      writeFileSync(swapped, 'Set-Content -LiteralPath "' + path.join(root, 'SWAPPED-RAN.txt') + '" 1\nexit 0\n');
      expect(runBootstrap(swapped, sha(real), '-Mode Install', '1').code).toBe(9);
      expect(runBootstrap(swapped, sha(real), '-Panel master -LeftoversOnly -Yes', '0').code).toBe(9);
      expect(existsSync(path.join(root, 'SWAPPED-RAN.txt'))).toBe(false);
    });
  });

  it('taskChildEnv is built from nothing: no .NET profiler, Node or user PATH can reach the elevated children', () => {
    const paths = {
      powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      stage: 'D:\\ProgramData\\OrderBook\\staged-update',
    };
    const made = taskChildEnv(paths, { TEMP: 'D:\\w\\tmp' });
    expect(made.SystemRoot).toBe('C:\\Windows');
    expect(made.ProgramData).toBe('D:\\ProgramData');
    expect(made.PATH).toBe('C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem');
    expect(made.TEMP).toBe('D:\\w\\tmp');
    for (const name of Object.keys(made)) expect(name).not.toMatch(/^(COR_|CORECLR_|COMPLUS_|DOTNET_|NODE_|ELECTRON_)/i);
    // Whatever this process has, none of it is copied across.
    expect(Object.keys(made).length).toBeLessThan(12);
  });

  it('the elevated script never reads process.env; the cmd and the installer macro clear the profiler variables', () => {
    expect(read('electron/apply-staged-update.ts')).not.toContain('process.env');
    const cmd = read('master/installer/apply-update/apply-update.cmd');
    for (const prefix of ['NODE_', 'ELECTRON_', 'COR_', 'CORECLR_', 'COMPLUS_', 'DOTNET_']) {
      expect(cmd).toContain(`'set ${prefix} 2^>nul'`);
    }
    for (const name of ['COR_ENABLE_PROFILING', 'COR_PROFILER', 'COR_PROFILER_PATH', 'CORECLR_PROFILER', 'CORECLR_PROFILER_PATH', 'DOTNET_STARTUP_HOOKS']) {
      expect(macro).toContain(`SetEnvironmentVariable(t "${name}"`);
    }
    expect(macro).toMatch(/!macro orderbookRunVerified[^\n]*\n\s*!insertmacro orderbookClearProfilerEnvironment/);
  });

  it('the uninstall sweep takes no delete target from the environment', () => {
    const sweep = read('tools/uninstall/uninstall-orderbook.ps1');
    const envUses = sweep.match(/\$env:\w+|\$\{env:[^}]+\}/gi) ?? [];
    expect(envUses.every((use) => /^\$env:PSModulePath$/i.test(use))).toBe(true);
    expect(sweep).not.toContain('ORDERBOOK_RELEASES_DIR=');
    expect(sweep).not.toMatch(/\$releasesDir = \$env/);
    expect(sweep).toContain('Get-DeleteRefusal $path');
    expect(sweep).toContain('Remove-InnerLinks $path');
  });

  it.runIf(process.platform === 'win32')('the delete guard refuses non-OrderBook folders, roots and links, and unlinks inner junctions without following them', () => {
    const sweep = read('tools/uninstall/uninstall-orderbook.ps1');
    const grab = (name: string): string => {
      const start = sweep.indexOf(`function ${name}(`);
      const next = sweep.indexOf('\nfunction ', start + 1);
      return sweep.slice(start, next).trimEnd();
    };
    const root = mkdtempSync(path.join(os.tmpdir(), 'ob-del-'));
    try {
      const keep = path.join(root, 'CompanyData');
      const app = path.join(root, 'OrderBook Master Panel');
      const victim = path.join(root, 'victim');
      mkdirSync(keep); mkdirSync(app); mkdirSync(victim);
      writeFileSync(path.join(victim, 'precious.txt'), 'x');
      writeFileSync(path.join(keep, 'data.txt'), 'x');
      const innerLink = path.join(app, 'inner');
      const aliasOrderBook = path.join(root, 'OrderBook-alias');
      const script = [
        '$DryRun = $false', '$script:counts = @{ kept = 0 }', 'function Note($a, $b) { Write-Output "NOTE $a $b" }',
        grab('Get-DeleteRefusal'), grab('Remove-InnerLinks'), grab('Remove-Leftover'),
        `New-Item -ItemType Junction -Path '${innerLink}' -Target '${victim}' | Out-Null`,
        `New-Item -ItemType Junction -Path '${aliasOrderBook}' -Target '${victim}' | Out-Null`,
        `foreach ($p in @('C:\\Windows', 'C:\\', '${keep}', '${aliasOrderBook}', '${path.join(aliasOrderBook, 'sub')}')) { "REFUSE|$p|" + [bool](Get-DeleteRefusal $p) }`,
        `foreach ($p in @('${app}', 'C:\\x\\OrderBook\\master', 'C:\\x\\orderbook-master-updater', 'C:\\OrderBook-Releases')) { "ALLOW|$p|" + [bool](Get-DeleteRefusal $p) }`,
        `Remove-Leftover '${app}' 'app'`,
        `Remove-Leftover '${keep}' 'data'`,
      ].join('\n');
      const file = path.join(root, 'guard.ps1');
      writeFileSync(file, script);
      const out = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8' }).stdout;
      for (const line of out.split(/\r?\n/).filter((l) => l.startsWith('REFUSE|'))) expect(line.endsWith('|True')).toBe(true);
      for (const line of out.split(/\r?\n/).filter((l) => l.startsWith('ALLOW|'))) expect(line.endsWith('|False')).toBe(true);
      expect(existsSync(app)).toBe(false);
      expect(existsSync(path.join(victim, 'precious.txt'))).toBe(true);
      expect(existsSync(path.join(keep, 'data.txt'))).toBe(true);
    } finally {
      try { spawnSync('cmd.exe', ['/c', 'rmdir', path.join(root, 'OrderBook-alias')]); } catch { /* not there */ }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('the Install call passes its folder as data and falls through to a failure', () => {
    expect(masterNsis).toContain('System::Call \'Kernel32::SetEnvironmentVariable(t "OB_INSTDIR", t "$INSTDIR")\'');
    expect(masterNsis).toContain('"-Mode Install -InstallDir $$env:OB_INSTDIR" "1"');
    // No path is pasted inside the command text any more.
    expect(macro).not.toContain('$INSTDIR');
    expect(macro).not.toContain('$PLUGINSDIR');
    expect(macro).toContain('catch { exit 1 }');
  });

  it('both uninstallers hash-check the sweep and run it from memory, not -File from a temp folder', () => {
    for (const [name, text, panel] of [['master', masterNsis, 'master'], ['office', officeNsis, 'office']] as const) {
      expect(text, name).toContain(`"-Panel ${panel} -LeftoversOnly -Yes $R7" "0"`);
      expect(text, name).toContain('"${UNINSTALL_SCRIPT_SHA256}"');
      expect(text, name).not.toMatch(/-File "\$TEMP\\OrderBook-uninstall/);
    }
  });

  it('the hashes are baked when the installer is COMPILED, by !system, so a stale one cannot survive a --prepackaged build', () => {
    for (const [name, text] of [['master', masterNsis], ['office', officeNsis]] as const) {
      const bake = text.indexOf('!system \'node "${__FILEDIR__}\\..\\..\\tools\\bake-script-hashes.cjs" "${__FILEDIR__}"\' = 0');
      const include = text.indexOf('!include "${__FILEDIR__}\\script-hashes.nsh"');
      expect(bake, name).toBeGreaterThan(-1);
      expect(include, name).toBeGreaterThan(bake);
    }
    // Not left to afterPack, which --prepackaged skips.
    expect(read('tools/flip-fuses.cjs')).not.toMatch(/writeUpdateDirsHash|update-dirs-hash/);
    expect(masterNsis).not.toContain('update-dirs-hash.nsh');
  });

  it('bakeScriptHashes writes the hashes of the exact bytes, overwrites a stale file, and fails when a script is missing', () => {
    const project = mkdtempSync(path.join(os.tmpdir(), 'ob-bake-'));
    try {
      const installer = path.join(project, 'master', 'installer');
      mkdirSync(path.join(installer, 'apply-update'), { recursive: true });
      mkdirSync(path.join(project, 'tools', 'uninstall'), { recursive: true });
      const uninstall = path.join(project, 'tools', 'uninstall', 'uninstall-orderbook.ps1');
      const update = path.join(installer, 'apply-update', 'update-dirs.ps1');
      writeFileSync(uninstall, 'sweep v1\n');
      writeFileSync(update, 'update v1\n');
      // A stale file from an earlier build.
      writeFileSync(path.join(installer, 'script-hashes.nsh'), '!define UPDATE_DIRS_SHA256 "stale"\n');

      bakeScriptHashes(installer);
      let baked = readFileSync(path.join(installer, 'script-hashes.nsh'), 'utf8');
      expect(baked).toContain(`!define UNINSTALL_SCRIPT_SHA256 "${sha('sweep v1\n')}"`);
      expect(baked).toContain(`!define UPDATE_DIRS_SHA256 "${sha('update v1\n')}"`);
      expect(baked).not.toContain('stale');

      // The script changes, the next compile bakes the new hash.
      writeFileSync(update, 'update v2\n');
      bakeScriptHashes(installer);
      baked = readFileSync(path.join(installer, 'script-hashes.nsh'), 'utf8');
      expect(baked).toContain(sha('update v2\n'));

      // An installer folder with no update script (the Office's) gets only the uninstall hash.
      const office = path.join(project, 'office', 'installer');
      mkdirSync(office, { recursive: true });
      bakeScriptHashes(office);
      const officeBaked = readFileSync(path.join(office, 'script-hashes.nsh'), 'utf8');
      expect(officeBaked).toContain('UNINSTALL_SCRIPT_SHA256');
      expect(officeBaked).not.toContain('UPDATE_DIRS_SHA256');

      // The CLI is what `!system` runs: it exits non-zero when a script is missing, which stops the compile.
      rmSync(uninstall);
      const failed = spawnSync(process.execPath, [path.join(repo, 'tools', 'bake-script-hashes.cjs'), installer], { encoding: 'utf8' });
      expect(failed.status).toBe(1);
      expect(() => bakeScriptHashes(installer)).toThrow(/uninstall script is missing/);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('the checked-in hashes are current for the scripts as they are now', () => {
    for (const folder of ['master/installer', 'office/installer']) {
      const baked = bakeScriptHashes(path.join(repo, folder));
      expect(baked.lines.join('\n')).toContain(sha(readFileSync(path.join(repo, 'tools', 'uninstall', 'uninstall-orderbook.ps1'))));
    }
  });
});
