import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { canonicalManifestPayload, isNewer } from '@orderbook/shared';
import { describe, expect, it } from 'vitest';

import {
  TASK_NAME,
  judgeInstallerFile,
  judgeStagedManifest,
  signatureHolds,
  stagedUpdateDirs,
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

describe('where the files live', () => {
  it('uses %ProgramData%\\OrderBook, staged for anybody and elevated for administrators', () => {
    expect(stagedUpdateDirs({ ProgramData: 'D:\\PD' })).toEqual({
      stage: 'D:\\PD\\OrderBook\\staged-update',
      work: 'D:\\PD\\OrderBook\\elevated',
    });
    expect(stagedUpdateDirs({}).stage).toBe('C:\\ProgramData\\OrderBook\\staged-update');
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
  const builder = read('master/electron-builder.yml');
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

  it('the script refuses to run when the administrators-only folder is missing', () => {
    expect(script).toMatch(/await stat\(work\)[\s\S]{0,80}return 3/);
  });

  it('the installer registers a highest-privilege task and an administrators-only folder', () => {
    expect(nsis).toContain('schtasks /Create /F /TN "OrderBook Master Update"');
    expect(nsis).toContain('/RL HIGHEST');
    expect(nsis).toContain('apply-update\\apply-update.cmd');
    // Administrators and SYSTEM by well-known SID, inheritance removed.
    expect(nsis).toMatch(/elevated" \/inheritance:r \/grant:r \*S-1-5-32-544:\(OI\)\(CI\)F \*S-1-5-18:\(OI\)\(CI\)F/);
    expect(nsis).toContain(TASK_NAME);
  });

  it('the uninstaller removes the task, but not during an update that may have been started by it', () => {
    const removal = nsis.indexOf('schtasks /Delete /F /TN "OrderBook Master Update"');
    const guard = nsis.lastIndexOf('${IfNot} ${isUpdated}', removal);
    expect(removal).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(-1);
    expect(nsis.slice(guard, removal)).not.toContain('${EndIf}');
  });

  it('the package ships the script, its helper and the launcher as real files', () => {
    for (const piece of ['apply-staged-update.js', 'lib/staged-update.js', 'apply-update/package.json', 'apply-update.cmd']) {
      expect(builder, piece).toContain(piece);
    }
  });

  it('the shell stages and checks before it stops the server', () => {
    const stage = shell.indexOf('stageForUpdateTask(verdict.path, prepared)');
    const stop = shell.indexOf('await stopServer();', stage);
    expect(stage).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(stage);
  });
});
