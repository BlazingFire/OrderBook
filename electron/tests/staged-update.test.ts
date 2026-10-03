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
  parseUpdatePaths,
  type ReleaseTrust,
  type StagedManifest,
} from '../lib/staged-update.js';
import { planInstallerLaunch } from '../lib/update-launch.js';

const repo = path.resolve(import.meta.dirname, '..', '..');
const read = (file: string): string => readFileSync(path.join(repo, file), 'utf8');

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
    // Not a single path comes from process.env; the only use is passing the rest of it on, with TEMP overridden.
    expect(script.match(/process\.env/g)?.length).toBe(1);
    expect(script).toMatch(/env: \{ \.\.\.process\.env, TEMP: temp, TMP: temp \}/);
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
    expect(nsis).toContain('-Mode Install -InstallDir \\"$INSTDIR\\"');
    // The system's own PowerShell, by absolute path, not whatever PATH finds.
    expect(nsis).toContain('"$SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe"');
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
    expect(ps1).not.toMatch(/\$env:/i);
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

describe('install-time commands are absolute, and the installer script is verified before it runs (CH1 hardening)', () => {
  const nsis = read('master/installer/installer.nsh');
  const ps1 = read('master/installer/apply-update/update-dirs.ps1');
  const { writeUpdateDirsHash } = createRequire(import.meta.url)('../../tools/flip-fuses.cjs') as {
    writeUpdateDirsHash: (projectDir: string) => string | null;
  };
  const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

  it('every program the installer runs elevated is named by its System32 path, never found through PATH or COMSPEC', () => {
    const lines = nsis.split('\n').filter((line) => /nsExec::/.test(line));
    expect(lines.length).toBeGreaterThan(3);
    for (const line of lines) {
      if (/netsh/.test(line)) continue; // the firewall rules predate this and have no user-writable path
      expect(line, line).toMatch(/\$SYSDIR\\/);
    }
    expect(nsis).not.toMatch(/nsExec::Exec 'schtasks /);
    expect(nsis).not.toMatch(/nsExec::Exec 'powershell\.exe/);
  });

  it("the task's command is cmd.exe by absolute path, with the script quoted for cmd /c", () => {
    expect(nsis).toContain('/TR "\\"$SYSDIR\\cmd.exe\\" /c \\"\\"$INSTDIR\\resources\\apply-update\\apply-update.cmd\\"\\""');
  });

  it('update-dirs.ps1 runs the system icacls by absolute path, always with /L', () => {
    expect(ps1).toContain("$Icacls = Join-Path ([Environment]::SystemDirectory) 'icacls.exe'");
    expect(ps1).not.toMatch(/& icacls\.exe/);
    const calls = ps1.split('\n').filter((line) => line.includes('& $Icacls'));
    expect(calls.length).toBeGreaterThan(1);
    for (const line of calls) expect(line, line).toContain('/L');
  });

  it('the installer script is checked against a build-time SHA-256 and run from memory, so a swap after the check changes nothing', () => {
    expect(nsis).toContain('!include "${BUILD_RESOURCES_DIR}\\apply-update\\update-dirs-hash.nsh"');
    expect(nsis).toMatch(/!ifndef UPDATE_DIRS_SHA256[\s\S]{0,200}!error/);
    expect(nsis).toContain('ReadAllBytes');
    expect(nsis).toContain('if ($$h -ne \\"${UPDATE_DIRS_SHA256}\\") { exit 9 }');
    expect(nsis).toContain('[scriptblock]::Create(');
    // Never `-File` on the extracted script for the Install mode.
    expect(nsis).not.toMatch(/-File "\$PLUGINSDIR\\update-dirs\.ps1"/);
    // The registered task is created only after the checked script says 0.
    expect(nsis.indexOf('/Create /F /TN')).toBeGreaterThan(nsis.indexOf('exit 9'));
  });

  it('afterPack bakes the SHA-256 of the exact script bytes into the include, and does nothing for a build without one', () => {
    const project = mkdtempSync(path.join(os.tmpdir(), 'ob-hash-'));
    try {
      expect(writeUpdateDirsHash(project)).toBeNull();
      mkdirSync(path.join(project, 'installer', 'apply-update'), { recursive: true });
      writeFileSync(path.join(project, 'installer', 'apply-update', 'update-dirs.ps1'), 'exit 0\n');
      expect(writeUpdateDirsHash(project)).toBe(sha('exit 0\n'));
      const written = readFileSync(path.join(project, 'installer', 'apply-update', 'update-dirs-hash.nsh'), 'utf8');
      expect(written).toContain(`!define UPDATE_DIRS_SHA256 "${sha('exit 0\n')}"`);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
    expect(readFileSync(path.join(repo, 'tools', 'flip-fuses.cjs'), 'utf8')).toContain('writeUpdateDirsHash(context.packager.projectDir)');
  });

  describe.skipIf(process.platform !== 'win32')('the verifying bootstrap, run for real', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ob-boot-'));
    afterAll(() => rmSync(root, { recursive: true, force: true }));
    const original = readFileSync(path.join(repo, 'master', 'installer', 'apply-update', 'update-dirs.ps1'));

    /** The very command line the installer builds, with NSIS's `$$` and the placeholders filled in, in Chain mode. */
    function bootstrap(file: string, expectedHash: string): number {
      const line = nsis.split('\n').find((l) => l.includes('-Command "$$b=')) ?? '';
      const command = /-Command "(.*)"'\s*$/.exec(line)?.[1] ?? '';
      expect(command).not.toBe('');
      const filled = command
        .replaceAll('$$', '$')
        .replaceAll('\\"', '"')
        .replace('$PLUGINSDIR\\update-dirs.ps1', file)
        .replace('${UPDATE_DIRS_SHA256}', expectedHash)
        .replace('-Mode Install -InstallDir "$INSTDIR"', `-Mode Chain -Path "${process.env.SystemRoot ?? 'C:\\Windows'}"`);
      return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', filled], {
        windowsHide: true,
      }).status ?? -1;
    }

    it('runs the script when the bytes are the ones that were hashed', () => {
      const file = path.join(root, 'good.ps1');
      writeFileSync(file, original);
      expect(bootstrap(file, createHash('sha256').update(original).digest('hex'))).toBe(0);
    });

    it('refuses a script that was changed after the hash was taken: exit 9, nothing run', () => {
      const file = path.join(root, 'swapped.ps1');
      writeFileSync(file, Buffer.concat([original, Buffer.from('\r\nWrite-Output "evil"; exit 0\r\n')]));
      expect(bootstrap(file, createHash('sha256').update(original).digest('hex'))).toBe(9);
    });

    it('refuses when the baked hash is wrong', () => {
      const file = path.join(root, 'wronghash.ps1');
      writeFileSync(file, original);
      expect(bootstrap(file, 'f'.repeat(64))).toBe(9);
    });
  });
});
