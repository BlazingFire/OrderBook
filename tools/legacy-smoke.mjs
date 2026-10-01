#!/usr/bin/env node
/**
 * Run the Windows 7 Office build's code on the runtimes it ships on:
 * `npm run smoke:legacy` (docs/WINDOWS7.md).
 *
 * The Windows 7 Office runs its server on Node 16.17.1 (inside Electron 22)
 * and its shell on Electron 22 as CommonJS. Vitest needs Node 18, so no unit
 * test can run there, and the lint and static guards only catch the API gaps
 * somebody thought to list. This runs the real thing:
 *
 *  1. Builds what it runs: shared, the Office server (`office/dist`) and the
 *     CommonJS shell stage (`npm run build:shell:legacy`).
 *  2. Fetches Node 16.17.1 from nodejs.org and Electron 22.3.27 from GitHub,
 *     each checked against its published SHA-256, into `.tmp/legacy-runtime`
 *     (gitignored, and cached by the CI job).
 *  3. Starts `office/dist` twice, on plain Node 16.17.1 and on Electron 22 as
 *     Node (how the shell runs it), each against a stub Master on loopback,
 *     and drives it through what Node 16 lacks: pairing (fetch from undici),
 *     a product CSV upload passed on to the Master (FormData and Blob), an
 *     update download (a streamed body through Readable.from), the
 *     connection status, the event stream, free disk space (no fs.statfs on
 *     Node 16) and a shutdown with a connection still open.
 *  4. Launches the Electron 22 main process on the CommonJS shell, checks the
 *     `{"type":"commonjs"}` marker beside it, and waits for the shell to bring
 *     the Office server up.
 *
 * The Electron run uses a scratch `appData`, so it never touches this PC's
 * real Office data. It leaves `office/electron/dist` as it found it: if the
 * ESM shell was there, `npm run build:shell` puts it back afterwards.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { LEGACY_ELECTRON, LEGACY_NODE } from './legacy-electron.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.tmp', 'legacy-runtime');
/** Scratch data folders, one per run, removed as each run ends. */
const SCRATCH = path.join(ROOT, '.tmp', 'legacy-smoke');
const OFFICE = path.join(ROOT, 'office');
const MARKER = path.join(OFFICE, 'electron', 'dist', 'package.json');

const USERNAME = 'smoke';
const PASSWORD = 'legacy-smoke-password';
const CSV = 'Product Code,Name\nSMOKE-1,Smoke test tile\n';

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function step(message) {
  console.log(`  - ${message}`);
}

function run(command, args) {
  console.log(`  $ ${command} ${args.join(' ')}`);
  execFileSync(command, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const isCommonJsStage = () => {
  try {
    return JSON.parse(readFileSync(MARKER, 'utf8')).type === 'commonjs';
  } catch {
    return false;
  }
};

/** The environment a child gets: ours, without anything that changes how it starts. */
function childEnv(extra) {
  const env = { ...process.env, ...extra };
  delete env.NODE_OPTIONS;
  if (!extra.ELECTRON_RUN_AS_NODE) delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

async function freePort() {
  const server = net.createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return port;
}

// ------------------------------------------------------------------ runtimes

/** Node 16.17.1 for this machine, downloaded once and checked against SHASUMS256.txt. */
async function legacyNode() {
  const platform = { win32: 'win', linux: 'linux', darwin: 'darwin' }[process.platform];
  const arch = { x64: 'x64', arm64: 'arm64', ia32: 'x86' }[process.arch];
  check(platform && arch, `No Node ${LEGACY_NODE} build for ${process.platform}-${process.arch}`);

  const name = `node-v${LEGACY_NODE}-${platform}-${arch}`;
  const dir = path.join(CACHE, name);
  const exe =
    process.platform === 'win32' ? path.join(dir, 'node.exe') : path.join(dir, 'bin', 'node');
  if (existsSync(exe)) return exe;

  const archive = `${name}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`;
  const base = `https://nodejs.org/dist/v${LEGACY_NODE}/`;
  step(`downloading ${archive}`);
  const sums = await (await fetch(`${base}SHASUMS256.txt`)).text();
  const expected = sums
    .split('\n')
    .find((line) => line.trim().endsWith(`  ${archive}`))
    ?.split(' ')[0];
  const response = await fetch(`${base}${archive}`);
  check(response.ok && expected, `Could not download ${base}${archive} (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  check(sha256(bytes) === expected, `${archive} does not match its published SHA-256`);

  await mkdir(CACHE, { recursive: true });
  const file = path.join(CACHE, archive);
  await writeFile(file, bytes);
  // Unpacked beside the cache and renamed into place, so an interrupted run
  // never leaves a half folder that the existsSync above would trust.
  const partial = `${dir}.partial`;
  await rm(partial, { recursive: true, force: true });
  await mkdir(partial, { recursive: true });
  if (archive.endsWith('.zip')) {
    const { default: extract } = await import('extract-zip');
    await extract(file, { dir: partial });
  } else {
    execFileSync('tar', ['-xzf', file, '-C', partial]);
  }
  await rename(path.join(partial, name), dir);
  await rm(partial, { recursive: true, force: true });
  await rm(file, { force: true });
  return exe;
}

/**
 * Electron 22.3.27 for this machine. `@electron/get` (installed with the
 * `electron` package) downloads it and checks it against the release's
 * SHASUMS256.txt, exactly as `node_modules/electron/install.js` does.
 */
async function legacyElectron() {
  const dir = path.join(CACHE, `electron-v${LEGACY_ELECTRON}-${process.platform}-${process.arch}`);
  const exe = path.join(
    dir,
    { win32: 'electron.exe', linux: 'electron', darwin: 'Electron.app/Contents/MacOS/Electron' }[
      process.platform
    ] ?? 'electron',
  );
  if (existsSync(exe)) return exe;

  step(`downloading Electron ${LEGACY_ELECTRON}`);
  const { downloadArtifact } = await import('@electron/get');
  const zip = await downloadArtifact({
    version: LEGACY_ELECTRON,
    artifactName: 'electron',
    platform: process.platform,
    arch: process.arch,
    cacheRoot: path.join(CACHE, 'downloads'),
  });
  const partial = `${dir}.partial`;
  await rm(partial, { recursive: true, force: true });
  const { default: extract } = await import('extract-zip');
  await extract(zip, { dir: partial });
  await rename(partial, dir);
  return exe;
}

function versionsOf(command, env = {}) {
  const result = spawnSync(command, ['-p', 'JSON.stringify(process.versions)'], {
    encoding: 'utf8',
    env: childEnv(env),
  });
  check(result.status === 0, `${command} would not start: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

// --------------------------------------------------------------- stub Master

/**
 * Just enough of a Master for the Office routes that need one. What each
 * request carried is kept in `seen` for the checks. The Socket.IO link is not
 * served: the Office keeps retrying it, which is what it does with a Master
 * that is off, and every route below works over plain HTTP.
 */
async function startStubMaster() {
  const update = randomBytes(3 * 1024 * 1024 + 321);
  const seen = { pairing: null, upload: null, platforms: [], downloads: 0 };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url, 'http://stub');
      const body = Buffer.concat(chunks);
      const json = (status, value) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(value));
      };

      if (req.method === 'POST' && url.pathname === '/api/pairing/request') {
        seen.pairing = JSON.parse(body.toString('utf8'));
        json(201, {
          panelId: 'OP0000000001',
          panelSecret: 'legacy-smoke-secret',
          masterUniqueId: 'MSMOKE',
          companyName: 'Legacy Smoke Co',
        });
      } else if (req.method === 'POST' && url.pathname === '/api/panel/products/import') {
        seen.upload = { headers: req.headers, body: body.toString('latin1') };
        json(200, { dryRun: true, created: 1, updated: 0, errors: [] });
      } else if (req.method === 'GET' && url.pathname === '/api/updates/office/latest') {
        const platform = url.searchParams.get('platform');
        seen.platforms.push(platform);
        json(200, {
          current: '1.0.0',
          available: {
            panel: 'office',
            platform,
            version: '99.0.0',
            file: 'OrderBook-Office-99.0.0-Setup.exe',
            sizeBytes: update.length,
            sha256: sha256(update),
            releasedAt: new Date().toISOString(),
          },
        });
      } else if (req.method === 'GET' && url.pathname === '/api/updates/office/download') {
        seen.downloads += 1;
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': update.length,
        });
        // In pieces, so the Office really streams it rather than getting one chunk.
        let at = 0;
        const next = () => {
          if (at >= update.length) return void res.end();
          res.write(update.subarray(at, at + 64 * 1024));
          at += 64 * 1024;
          setImmediate(next);
        };
        next();
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { port: server.address().port, seen, update, server };
}

// ------------------------------------------------------------- the scenario

async function waitForHealth(base, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    check(child.exitCode === null, `the process exited early (code ${child.exitCode})`);
    try {
      const health = await (await fetch(`${base}/api/health`)).json();
      if (health.panel === 'office' && health.status === 'ok') return health;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`no healthy Office at ${base} within ${timeoutMs / 1000} s`);
}

async function call(base, method, route, body) {
  const init = { method };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json' };
  }
  const response = await fetch(`${base}${route}`, init);
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON: the caller looks at `text`.
  }
  return { status: response.status, headers: response.headers, body: parsed, text };
}

/** office/dist on one runtime, against the stub, through every path Node 16 lacks. */
async function officeScenario(runtime, stub) {
  console.log(`\n== Office server on ${runtime.label} ==`);
  await mkdir(SCRATCH, { recursive: true });
  const dir = await mkdtemp(path.join(SCRATCH, 'office-'));
  const dataDir = path.join(dir, 'data');
  await mkdir(dataDir, { recursive: true });

  // Somebody who has signed in here before, so the offline sign-in lets the
  // smoke reach the routes behind it without a Master link.
  const { mintVerifier } = await import(
    pathToFileURL(path.join(OFFICE, 'dist', 'lib', 'password.js')).href
  );
  await writeFile(
    path.join(dataDir, 'users.json'),
    JSON.stringify({
      users: [
        {
          userId: 'US0000000001',
          username: USERNAME,
          displayName: 'Legacy Smoke',
          roleId: null,
          roleName: 'Admin',
          roleTier: 'admin',
          verifier: await mintVerifier(PASSWORD),
          credentialFingerprint: 'smoke',
          permissions: ['settings.manage', 'products.view', 'products.edit'],
          roleVersion: 1,
          masterToken: null,
          lastSignInAt: new Date().toISOString(),
          avatarId: null,
          blurhash: null,
        },
      ],
    }),
  );

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(runtime.command, [path.join(OFFICE, 'dist', 'index.js')], {
    cwd: OFFICE,
    env: childEnv({
      ...runtime.env,
      ORDERBOOK_OFFICE_DATA_DIR: dataDir,
      ORDERBOOK_OFFICE_SETTINGS_FILE: path.join(dir, 'office-settings.env'),
      OFFICE_PORT: String(port),
      OFFICE_PANEL_NAME: 'Legacy smoke',
      // The stub's update manifest is unsigned; a test key is not worth it.
      ORDERBOOK_ALLOW_UNSIGNED_RELEASES: '1',
    }),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));

  let events = null;
  try {
    const health = await waitForHealth(base, child, 30_000);
    step(`listening, version ${health.version}`);

    let connection = await call(base, 'GET', '/api/connection');
    check(
      connection.status === 200 && connection.body.isPaired === false,
      '/api/connection before pairing',
    );

    const pair = await call(base, 'POST', '/api/connection/pair/manual', {
      host: '127.0.0.1',
      port: stub.port,
      pairingPassword: 'smoke-pairing',
    });
    check(pair.status === 201, `pairing answered ${pair.status}: ${pair.text}`);
    check(
      stub.seen.pairing?.mode === 'manual' && stub.seen.pairing.pairingPassword === 'smoke-pairing',
      'the Master did not receive the pairing request',
    );
    connection = await call(base, 'GET', '/api/connection');
    check(connection.body.isPaired === true, '/api/connection does not report the pairing');
    step('paired (fetch through undici), /api/connection answers');

    const signIn = await call(base, 'POST', '/api/auth/sign-in', {
      username: USERNAME,
      password: PASSWORD,
    });
    check(
      signIn.status === 200 && signIn.body.session,
      `sign-in answered ${signIn.status}: ${signIn.text}`,
    );

    const form = new FormData();
    form.append('file', new Blob([CSV], { type: 'text/csv' }), 'products.csv');
    form.append('dryRun', 'true');
    form.append('mode', 'create');
    const upload = await call(base, 'POST', '/api/products/import', form);
    check(upload.status === 200, `the product upload answered ${upload.status}: ${upload.text}`);
    const sent = stub.seen.upload;
    check(sent, 'the upload never reached the Master');
    check(
      String(sent.headers['content-type']).startsWith('multipart/form-data; boundary='),
      `the upload reached the Master as ${sent.headers['content-type']}`,
    );
    check(
      sent.headers['x-orderbook-panel-id'] === 'OP0000000001',
      'the upload lost its panel headers',
    );
    for (const part of [
      'filename="products.csv"',
      CSV,
      'name="dryRun"\r\n\r\ntrue',
      'name="mode"\r\n\r\ncreate',
    ]) {
      check(
        sent.body.includes(part),
        `the upload reached the Master without ${JSON.stringify(part)}`,
      );
    }
    step('product CSV upload passed on as multipart (FormData and Blob)');

    const available = await call(base, 'GET', '/api/updates/available');
    check(available.status === 200, `update check answered ${available.status}: ${available.text}`);
    check(
      stub.seen.platforms.at(-1) === runtime.platform,
      `asked for the ${stub.seen.platforms.at(-1)} channel, expected ${runtime.platform}`,
    );
    check(available.body.available?.version === '99.0.0', `no update offered: ${available.text}`);

    const download = await call(base, 'POST', '/api/updates/download');
    check(download.status === 200, `update download answered ${download.status}: ${download.text}`);
    const file = await readFile(download.body.path);
    check(
      sha256(file) === sha256(stub.update),
      'the downloaded update does not match what was sent',
    );
    step(`update on the ${runtime.platform} channel downloaded and verified (Readable.from)`);

    // Node 16 has no fs.statfs, so on Windows the answer comes from wmic. Where
    // wmic exists (Windows 7 to 11 23H2, and the CI runner) it must give a number;
    // null is only right where wmic was removed, as on Windows 11 24H2.
    const storage = await call(base, 'GET', '/api/storage/path');
    const free = storage.body?.freeBytes;
    const hasWmic =
      process.platform === 'win32' &&
      spawnSync('where', ['wmic'], { stdio: 'ignore' }).status === 0;
    check(
      storage.status === 200 && (typeof free === 'number' ? free > 0 : free === null && !hasWmic),
      `free disk space answered ${storage.status}: ${storage.text}${hasWmic ? ' (wmic is present, so a number was expected)' : ''}`,
    );
    step(
      `free disk space: ${free === null ? 'unknown (no statfs and no wmic here)' : `${Math.round(free / 2 ** 30)} GB`}`,
    );

    // Left open on purpose: the shutdown below has to end it.
    events = new AbortController();
    const stream = await fetch(`${base}/api/events`, { signal: events.signal });
    check(stream.status === 200, `the event stream answered ${stream.status}`);
    const reader = stream.body.getReader();
    let received = '';
    while (!received.includes('event: status')) {
      const { value, done } = await reader.read();
      check(!done, 'the event stream ended before its first status');
      received += Buffer.from(value).toString('utf8');
    }
    step('event stream sends its first status');

    // The built web app, or this panel's own page saying it was never built.
    const page = await call(base, 'GET', '/');
    const built = existsSync(path.join(OFFICE, 'web', 'dist', 'index.html'));
    check(
      page.status === (built ? 200 : 503) &&
        String(page.headers.get('content-type')).includes('text/html'),
      `GET / answered ${page.status}`,
    );

    // Tracked sockets, not closeAllConnections (Node 18.2): with the event
    // stream still open, the shutdown has to end it itself to finish.
    child.send({ type: 'orderbook:shutdown' });
    const exit = await Promise.race([
      once(child, 'exit'),
      new Promise((resolve) => setTimeout(() => resolve(null), 10_000)),
    ]);
    check(exit !== null, 'the server did not shut down within 10 s with a connection open');
    check(exit[0] === 0, `the server shut down with code ${exit[0]}`);
    step('shut down cleanly with the event stream open');
  } catch (error) {
    console.error(`\n--- Office output (${runtime.label}) ---\n${output.slice(-6000)}`);
    throw error;
  } finally {
    events?.abort();
    if (child.exitCode === null) child.kill();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// --------------------------------------------------------- the Electron main

/**
 * The Windows 7 shell as Electron 22 starts it: the CommonJS stage through the
 * CommonJS loader, under the panel's `"type": "module"` package.json. A small
 * wrapper app points `appData` and `userData` at a scratch folder (so this
 * PC's real Office data and its single-instance lock are left alone), sets
 * the app path to the Office folder as a launch of `electron office` would,
 * and requires `office.main.js`.
 */
async function electronMain(electron) {
  console.log(`\n== Electron ${LEGACY_ELECTRON} main process ==`);
  check(isCommonJsStage(), `${path.relative(ROOT, MARKER)} is not {"type":"commonjs"}`);
  step('the CommonJS marker sits beside the legacy shell');

  await mkdir(SCRATCH, { recursive: true });
  const dir = await mkdtemp(path.join(SCRATCH, 'shell-'));
  const appDir = path.join(dir, 'app');
  await mkdir(appDir);
  await mkdir(path.join(dir, 'appData'));
  await mkdir(path.join(dir, 'userData'));
  await writeFile(
    path.join(appDir, 'package.json'),
    JSON.stringify({ name: 'orderbook-legacy-smoke', main: 'main.js' }),
  );
  await writeFile(
    path.join(appDir, 'main.js'),
    [
      "const { app } = require('electron');",
      // Run as Node there is no Chromium, so its version is read here.
      'console.log(`smoke-chrome=${process.versions.chrome}`);',
      `app.setPath('appData', ${JSON.stringify(path.join(dir, 'appData'))});`,
      `app.setPath('userData', ${JSON.stringify(path.join(dir, 'userData'))});`,
      `app.setAppPath(${JSON.stringify(OFFICE)});`,
      `require(${JSON.stringify(path.join(OFFICE, 'electron', 'dist', 'office.main.js'))});`,
    ].join('\n'),
  );

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  // `--in-process-gpu`: what is checked is the main process and the server it
  // starts, not the GPU. A session that may not start Chromium's sandboxed
  // helper processes (a locked-down agent or service account) otherwise loses
  // the whole app to "GPU process isn't usable"; the window's renderer failing
  // there is harmless to these checks.
  const child = spawn(electron, ['--in-process-gpu', appDir], {
    env: childEnv({ OFFICE_PORT: String(port) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));

  try {
    const health = await waitForHealth(base, child, 60_000);
    check(
      typeof health.dataDir === 'string' && health.dataDir.startsWith(dir),
      `the shell started the server on ${health.dataDir}, not the scratch folder`,
    );
    const chrome = /smoke-chrome=(\S+)/.exec(output)?.[1];
    check(chrome?.startsWith('108.'), `the main process runs Chromium ${chrome}`);
    step(`the shell loaded as CommonJS on Chromium ${chrome} and brought the Office server up`);
  } catch (error) {
    console.error(`\n--- Electron output ---\n${output.slice(-6000)}`);
    throw error;
  } finally {
    // The whole tree: the window's helper processes and the server child.
    if (child.exitCode === null) {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
      } else {
        child.kill();
      }
      await Promise.race([once(child, 'exit'), new Promise((r) => setTimeout(r, 10_000))]);
    }
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// --------------------------------------------------------------------- main

async function main() {
  const hadCommonJsStage = isCommonJsStage();
  console.log('== Build ==');
  run('npm', ['run', 'build:shared']);
  run('npm', ['run', 'build:server', '--workspace', '@orderbook/office']);
  run('npm', ['run', 'build:shell:legacy']);

  let stub = null;
  try {
    console.log('\n== Runtimes ==');
    const node = await legacyNode();
    const electron = await legacyElectron();

    const nodeVersions = versionsOf(node);
    check(nodeVersions.node === LEGACY_NODE, `${node} is Node ${nodeVersions.node}`);
    const electronVersions = versionsOf(electron, { ELECTRON_RUN_AS_NODE: '1' });
    check(
      electronVersions.electron === LEGACY_ELECTRON,
      `Electron is ${electronVersions.electron}`,
    );
    check(
      electronVersions.node === LEGACY_NODE,
      `Electron ${LEGACY_ELECTRON} runs Node ${electronVersions.node}`,
    );
    step(
      `Node ${nodeVersions.node}; Electron ${electronVersions.electron} with Node ${electronVersions.node}`,
    );

    stub = await startStubMaster();
    // `releasePlatformFor()`: plain Node is the platform's own channel, and
    // Electron 22 on Windows is the win7 one.
    await officeScenario(
      { label: `Node ${LEGACY_NODE}`, command: node, env: {}, platform: process.platform },
      stub,
    );
    await officeScenario(
      {
        label: `Electron ${LEGACY_ELECTRON} as Node`,
        command: electron,
        env: { ELECTRON_RUN_AS_NODE: '1' },
        platform: process.platform === 'win32' ? 'win7' : process.platform,
      },
      stub,
    );

    await electronMain(electron);
  } finally {
    stub?.server.close();
    if (!hadCommonJsStage) {
      console.log('\n== Putting the ESM shell back in office/electron/dist ==');
      run('npm', ['run', 'build:shell']);
    }
  }

  console.log('\nLegacy smoke passed.');
}

main().catch((error) => {
  console.error(`\nLegacy smoke failed: ${error.message}`);
  process.exit(1);
});
