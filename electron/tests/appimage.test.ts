/**
 * Updating the Linux AppImage in place: knowing which file this copy was
 * launched from, replacing it without disturbing the copy that is running,
 * and starting the new one only once the old one has gone.
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  detectAppImage,
  relaunchArguments,
  relaunchCommand,
  replaceAppImage,
  startDetached,
} from '../lib/appimage.js';

const APPIMAGE = path.resolve('/home/shop/Applications/OrderBook-Master-1.2.0-Setup.AppImage');
const MOUNT = path.resolve('/tmp/.mount_OrderBAbc123');
const EXECUTABLE = path.join(MOUNT, 'orderbook-master');

describe('knowing which AppImage this copy was launched from', () => {
  const launched = { APPIMAGE, APPDIR: MOUNT };

  it('recognises the variables the AppImage runtime sets, and the mount it runs from', () => {
    expect(detectAppImage('linux', launched, EXECUTABLE, true)).toBe(APPIMAGE);
  });

  it('is never an AppImage when run from source', () => {
    // The same reason as the standalone build: the variables are inherited,
    // and a developer's terminal must not turn `npm run dev` into something
    // that overwrites files.
    expect(detectAppImage('linux', launched, EXECUTABLE, false)).toBeNull();
  });

  it('is never an AppImage off Linux', () => {
    expect(detectAppImage('win32', launched, EXECUTABLE, true)).toBeNull();
    expect(detectAppImage('darwin', launched, EXECUTABLE, true)).toBeNull();
  });

  it('ignores variables inherited from some other AppImage', () => {
    // The case that makes the mount check necessary. A `.deb` copy started
    // from a terminal inside another AppImage — an editor's built-in terminal
    // is the usual one — carries that application's APPIMAGE and APPDIR.
    // Believing them would overwrite somebody else's program with ours.
    const debInstall = path.resolve('/opt/OrderBook Master Panel/orderbook-master');
    const editor = { APPIMAGE: path.resolve('/home/shop/Editor.AppImage'), APPDIR: MOUNT };
    expect(detectAppImage('linux', editor, debInstall, true)).toBeNull();
  });

  it('refuses a mount that merely shares a prefix with the executable’s folder', () => {
    expect(
      detectAppImage('linux', launched, path.join(`${MOUNT}-other`, 'orderbook-master'), true),
    ).toBeNull();
  });

  it.skipIf(process.platform === 'win32')(
    'finds the executable under a mount reached through a symlink',
    async () => {
      // The runtime mounts under `$TMPDIR` and reports that path as it was
      // given, while the executable's own path has every link resolved — so a
      // temporary folder under a linked home (Fedora Silverblue's `/home` is
      // one) must not read as "not an AppImage" and refuse the update.
      const dir = await mkdtemp(path.join(os.tmpdir(), 'orderbook-mount-'));
      try {
        const real = path.join(dir, 'real');
        const linked = path.join(dir, 'linked');
        await mkdir(real);
        await symlink(real, linked);

        const executable = path.join(await realpath(real), 'orderbook-master');
        expect(detectAppImage('linux', { APPIMAGE, APPDIR: linked }, executable, true)).toBe(
          APPIMAGE,
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it('refuses when either variable is missing, blank or relative', () => {
    for (const env of [
      {},
      { APPDIR: MOUNT },
      { APPIMAGE },
      { APPIMAGE: '', APPDIR: MOUNT },
      { APPIMAGE, APPDIR: '' },
      { APPIMAGE: 'OrderBook.AppImage', APPDIR: MOUNT },
      { APPIMAGE, APPDIR: 'mount' },
    ]) {
      expect(detectAppImage('linux', env, EXECUTABLE, true), JSON.stringify(env)).toBeNull();
    }
  });
});

// POSIX file semantics throughout — a mode of 0755, a symlink an ordinary
// account may make, a rename over a file that is open — none of which Windows
// has; and only the Linux shell ever replaces an AppImage.
describe.skipIf(process.platform === 'win32')('replacing the AppImage', () => {
  let dir: string;
  let target: string;
  let verified: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'orderbook-appimage-'));
    target = path.join(dir, 'OrderBook-Master-1.2.0-Setup.AppImage');
    verified = path.join(dir, 'staged.AppImage');
    await writeFile(target, 'the version that is running');
    await chmod(target, 0o755);
    await writeFile(verified, 'the version that was verified');
    await chmod(verified, 0o600);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('puts the verified bytes at the same path, executable', async () => {
    // The same path, whatever version its name carries: a desktop shortcut or
    // a symlink the person made still points at it tomorrow.
    await replaceAppImage(verified, target);

    expect(await readFile(target, 'utf8')).toBe('the version that was verified');
    // An AppImage that is not executable is a file that will not start, and
    // nothing made the staged copy executable: it has whatever mode the
    // download was written with.
    expect((await stat(target)).mode & 0o777).toBe(0o755);
  });

  it('leaves the running copy’s bytes alone — a new file is renamed over it', async () => {
    // The running app is served from its own file by the AppImage runtime.
    // Writing into that file would change the program underneath it; a rename
    // leaves the old bytes readable by whatever still has them open.
    const running = await open(target, 'r');
    try {
      await replaceAppImage(verified, target);
      const { buffer, bytesRead } = await running.read(Buffer.alloc(64), 0, 64, 0);
      expect(buffer.subarray(0, bytesRead).toString()).toBe('the version that is running');
    } finally {
      await running.close();
    }
  });

  it('leaves nothing behind beside it', async () => {
    await replaceAppImage(verified, target);
    expect((await readdir(dir)).sort()).toEqual([path.basename(target), 'staged.AppImage'].sort());
  });

  it('clears what an attempt that died halfway left, and carries on', async () => {
    const leftover = path.join(dir, `.${path.basename(target)}.update`);
    await writeFile(leftover, 'half of an earlier download');

    await replaceAppImage(verified, target);

    expect(await readFile(target, 'utf8')).toBe('the version that was verified');
    await expect(stat(leftover)).rejects.toThrow();
  });

  it('never writes through a link planted where the new file goes', async () => {
    // The folder is the person's, so the new file is created fresh rather than
    // opened: a link waiting at that name must not redirect the write.
    const victim = path.join(dir, 'victim');
    await writeFile(victim, 'somebody else s file');
    await symlink(victim, path.join(dir, `.${path.basename(target)}.update`));

    await replaceAppImage(verified, target);

    expect(await readFile(victim, 'utf8')).toBe('somebody else s file');
    expect(await readFile(target, 'utf8')).toBe('the version that was verified');
  });

  it('leaves the running copy in place, and nothing beside it, when the copy fails', async () => {
    await expect(replaceAppImage(path.join(dir, 'not-there'), target)).rejects.toThrow();

    expect(await readFile(target, 'utf8')).toBe('the version that is running');
    expect((await readdir(dir)).sort()).toEqual([path.basename(target), 'staged.AppImage'].sort());
  });
});

describe('starting the new AppImage once this one has gone', () => {
  it('passes the paths as arguments, never as script text', () => {
    // A folder name with a quote or a `$(…)` in it must stay a folder name.
    const odd = path.resolve('/home/shop/it"s $(rm -rf ~)/OrderBook.AppImage');
    const command = relaunchCommand(odd, 4242, ['--no-sandbox']);

    expect(command.file).toBe('/bin/sh');
    expect(command.args[0]).toBe('-c');
    expect(command.args[1]).not.toContain(odd);
    expect(command.args.slice(2)).toEqual(['4242', odd, '--no-sandbox']);
  });

  it('starts the new copy extracted when this one was started with --appimage-extract-and-run', () => {
    // How an AppImage runs where FUSE is missing — and the runtime consumes
    // the flag: it unpacks the image under `$TMPDIR/appimage_extracted_<digest>`
    // and starts the app without it, so it is never in `process.argv`.
    // Relaunched without it, the new copy would try to mount, fail, and leave
    // nothing running. First, because the runtime reads only the first
    // argument that starts `--`, and `--no-sandbox` is one.
    const extracted = { APPIMAGE, APPDIR: path.resolve('/tmp/appimage_extracted_0123abcd') };
    expect(relaunchArguments(extracted, ['--no-sandbox'])).toEqual([
      '--appimage-extract-and-run',
      '--no-sandbox',
    ]);
  });

  it('adds nothing for a copy that was mounted, or told to extract by its environment', () => {
    expect(relaunchArguments({ APPIMAGE, APPDIR: MOUNT }, ['--no-sandbox'])).toEqual([
      '--no-sandbox',
    ]);
    // The variable asks the runtime for the same thing, and the relaunch
    // inherits it.
    const asked = {
      APPIMAGE,
      APPDIR: path.resolve('/tmp/appimage_extracted_0123abcd'),
      APPIMAGE_EXTRACT_AND_RUN: '1',
    };
    expect(relaunchArguments(asked, ['--no-sandbox'])).toEqual(['--no-sandbox']);
    expect(relaunchArguments({}, [])).toEqual([]);
  });

  it('reports a relaunch that could not be started, rather than resolving as if it had', async () => {
    // `spawn` reports a program it cannot start as an asynchronous 'error'
    // event, never a throw, so a try/catch around it alone never sees one: the
    // shell would quit with nothing started instead of putting its server back.
    const missing = path.join(os.tmpdir(), `orderbook-no-such-program-${process.pid}`);
    await expect(startDetached({ file: missing, args: [] })).rejects.toThrow(/ENOENT/);
  });

  // Detached, a Windows child gets a console window of its own; only Linux
  // uses this.
  it.skipIf(process.platform === 'win32')(
    'resolves once a program that exists has started',
    async () => {
      await expect(
        startDetached({ file: process.execPath, args: ['-e', ''] }),
      ).resolves.toBeUndefined();
    },
  );

  // It runs `/bin/sh`, which Windows does not have; only Linux uses this.
  it.skipIf(process.platform === 'win32')(
    'waits for the old process to exit, then runs the new file with the same arguments',
    async () => {
      // Launching while the old copy still holds the single-instance lock would
      // show "already running" and quit, leaving nothing running at all.
      const dir = await mkdtemp(path.join(os.tmpdir(), 'orderbook-relaunch-'));
      try {
        const marker = path.join(dir, 'marker');
        const fake = path.join(dir, 'OrderBook.AppImage');
        await writeFile(
          fake,
          [
            '#!/bin/sh',
            // Whether the old process was still there, and whether an inherited
            // descriptor was still open, at the moment the new one started.
            'if kill -0 "$1" 2>/dev/null; then state=alive; else state=gone; fi',
            'if { true >&3; } 2>/dev/null; then fd=open; else fd=closed; fi',
            'printf "%s %s %s" "$state" "$fd" "$3" > "$2"',
            '',
          ].join('\n'),
        );
        await chmod(fake, 0o755);

        const old = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1200)'], {
          stdio: 'ignore',
        });
        const exited = once(old, 'exit');
        if (old.pid === undefined) throw new Error('the stand-in for the old copy did not start');

        const command = relaunchCommand(fake, old.pid, [
          String(old.pid),
          marker,
          'with an argument',
        ]);
        // Descriptor 3 stands in for the AppImage runtime's keep-alive pipe,
        // which the old copy holds without close-on-exec: carried into the new
        // copy, it would keep the old image mounted for as long as that runs.
        const relauncher = spawn(command.file, command.args, {
          stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
        });
        const relaunched = once(relauncher, 'exit');

        await Promise.all([exited, relaunched]);

        expect(await readFile(marker, 'utf8')).toBe('gone closed with an argument');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
