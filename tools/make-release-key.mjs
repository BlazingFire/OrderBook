#!/usr/bin/env node
/**
 * Mint the Ed25519 key that signs releases, once.
 *
 *   npm run release:keygen
 *
 * Writes the **private** half to a file this script refuses to put anywhere
 * inside the repository, and rewrites `shared/src/domain/release-keys.ts` with
 * the public half so every build from here on trusts it.
 *
 * ### Why this exists at all
 *
 * The setup files are unsigned — `signAndEditExecutable: false`, because a
 * code-signing certificate is a purchase rather than a code change. That leaves
 * the SHA-256 as the only integrity story, and a digest published beside the
 * file it describes proves only that the two agree: whoever replaces one
 * replaces the other. Signing the manifest with a key that never leaves this
 * machine is the part that says *we* published it, and it costs nothing.
 *
 * ### Where the private key should live
 *
 * On the machine that cuts releases, and nowhere else. Putting it in a CI
 * secret means anybody who can push a workflow file can sign a release with it,
 * which gives away most of what it was for — if builds are produced in CI,
 * sign the manifest here afterwards and upload it, rather than handing the key
 * to the runner.
 */

import { generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEYS_FILE = path.join(ROOT, 'shared', 'src', 'domain', 'release-keys.ts');

const DEFAULT_KEY_DIR = path.join(os.homedir(), '.orderbook');

function fail(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

const keyId = process.argv[2] ?? `release-${new Date().toISOString().slice(0, 10)}`;
const outDir = path.resolve(process.env.ORDERBOOK_RELEASE_KEY_DIR ?? DEFAULT_KEY_DIR);

// A private key inside the repository is a private key one `git add -A` away
// from being public. The check is cheap and the mistake is permanent.
if (!path.relative(ROOT, outDir).startsWith('..')) {
  fail(
    `Refusing to write a private key inside the repository (${outDir}).\n` +
      `  Set ORDERBOOK_RELEASE_KEY_DIR to somewhere outside it.`,
  );
}

const privatePath = path.join(outDir, `${keyId}.private.pem`);

if (existsSync(privatePath)) {
  fail(`${privatePath} already exists. Delete it deliberately, or pass a different key id.`);
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519');

await mkdir(outDir, { recursive: true });
await writeFile(privatePath, privateKey.export({ format: 'pem', type: 'pkcs8' }), {
  encoding: 'utf8',
  mode: 0o600,
});

const publicDer = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

// Append rather than replace: rotation needs an overlap, where a build trusts
// the outgoing key and the incoming one at the same time.
const source = await readFile(KEYS_FILE, 'utf8');
const marker = '] as const;';
const anchor = source.lastIndexOf('export const TRUSTED_RELEASE_KEYS');
if (anchor < 0) fail(`Could not find TRUSTED_RELEASE_KEYS in ${KEYS_FILE}`);

const listEnd = source.indexOf('];', anchor);
if (listEnd < 0) fail(`Could not find the end of TRUSTED_RELEASE_KEYS in ${KEYS_FILE}`);

const entry =
  `  {\n` +
  `    keyId: '${keyId}',\n` +
  `    publicKey: '${publicDer}',\n` +
  `    addedAt: '${new Date().toISOString().slice(0, 10)}',\n` +
  `  },\n`;

await writeFile(KEYS_FILE, source.slice(0, listEnd) + entry + source.slice(listEnd), 'utf8');

console.log(`
  Key id       ${keyId}
  Private key  ${privatePath}   (mode 600 — back this up somewhere safe)
  Public key   added to shared/src/domain/release-keys.ts

  Next:
    1. Commit the change to release-keys.ts and ship a build carrying it.
       A machine can only trust a key its own build knows about, so the fleet
       has to take this build BEFORE the first release signed with the key.
    2. Then: npm run release
`);
void marker;
