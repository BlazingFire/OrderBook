/**
 * The Rust sidecar (`rust/crates/orderbook-helper`), spawned per call.
 *
 * Every caller uses {@link tryHelper} and falls back to the TypeScript
 * implementation on `null`, so a missing, outdated or crashing helper binary
 * never changes a feature — it only costs the speedup. The binary takes one
 * JSON request on stdin and answers one JSON response on stdout; it reads no
 * files and opens no sockets.
 *
 * The twin `office/src/lib/rust-bridge.ts` is deliberately duplicated rather
 * than shared: `@orderbook/shared` ships to the browser bundles too, and a
 * `node:child_process` import cannot go there.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** One helper round trip never holds a request longer than this. */
const HELPER_TIMEOUT_MS = 15_000;

/** Whole-page batches stay far below this; past it the call falls back. */
const HELPER_MAX_BUFFER = 8 * 1024 * 1024;

export interface HelperSuccess {
  ok: true;
  value: unknown;
}

export interface HelperFailure {
  ok: false;
  error: string;
}

export type HelperResponse = HelperSuccess | HelperFailure;

let cachedPath: string | null | undefined;

/**
 * Where the helper binary lives: `ORDERBOOK_RUST_HELPER` wins, otherwise
 * `rust/target/release/` beside this repo. Null when no binary is there —
 * a packaged install or a checkout without a Rust build simply falls back.
 */
export function helperPath(): string | null {
  if (cachedPath !== undefined) return cachedPath;
  const override = process.env.ORDERBOOK_RUST_HELPER?.trim();
  if (override) {
    cachedPath = override;
    return cachedPath;
  }
  const exe = `orderbook-helper${process.platform === 'win32' ? '.exe' : ''}`;
  // `src/lib` and the compiled `dist/lib` both sit three levels under the root.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const candidate = path.join(root, 'rust', 'target', 'release', exe);
  cachedPath = existsSync(candidate) ? candidate : null;
  return cachedPath;
}

/** Test seam: forgets the cached lookup so each test starts clean. */
export function resetRustBridgeForTest(): void {
  cachedPath = undefined;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Runs the binary once with `payload` on stdin. Rejects on spawn failure,
 * timeout, output past the byte cap, or a nonzero exit — every one of which
 * the caller turns into the TypeScript fallback.
 */
function runOnce(binary: string, payload: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(binary, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`rust helper timed out after ${HELPER_TIMEOUT_MS}ms`));
    }, HELPER_TIMEOUT_MS);
    // A helper that outlives its request must never hold the server open.
    timer.unref();
    const { stdin, stdout } = child;
    if (!stdin || !stdout) {
      clearTimeout(timer);
      child.kill();
      reject(new Error('rust helper stdio unavailable'));
      return;
    }
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    let output = '';
    child.on('error', (error: Error) => fail(error));
    stdout.on('data', (chunk: Buffer) => {
      output += String(chunk);
      if (Buffer.byteLength(output) > HELPER_MAX_BUFFER) {
        child.kill();
        fail(new Error('rust helper output exceeded its byte cap'));
      }
    });
    child.on('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(`rust helper exited with code ${String(code)}`));
    });
    stdin.on('error', (error: Error) => fail(asError(error)));
    stdin.write(payload, (writeError?: Error | null) => {
      if (writeError) fail(asError(writeError));
      else stdin.end();
    });
  });
}

/**
 * Runs one helper request, or null when the helper is unavailable, slow,
 * or answers anything but `{ok:true}`. Callers fall back to TypeScript.
 */
export async function tryHelper(request: unknown): Promise<unknown | null> {
  const binary = helperPath();
  if (!binary) return null;
  try {
    const stdout = await runOnce(binary, JSON.stringify(request) ?? '');
    const response = JSON.parse(stdout) as HelperResponse;
    if (typeof response !== 'object' || response === null || response.ok !== true) return null;
    return (response as HelperSuccess).value;
  } catch {
    return null;
  }
}
