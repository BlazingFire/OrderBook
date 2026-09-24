/**
 * The Release workflow's `check` job, run rather than read.
 *
 * `check` is the one step that decides whether a run creates the real GitHub
 * Release every Master polls, or a draft pre-release nobody's fleet ever sees.
 * It is forty lines of bash inside a YAML file, which nothing compiled or ran
 * until a workflow fired — and the rule the workflow's own input described,
 * "publish (main only)", was never in it: a hand-run with *publish* ticked on
 * any branch created `v<version>` from that branch's commit, and every Master
 * polling the releases repository would have offered it.
 *
 * So this lifts the step's script out of `release.yml` and runs it under bash,
 * with `gh` and `git` stubbed on the PATH, and reads back what it wrote to
 * `$GITHUB_OUTPUT` — the values `create-release` and the build matrix branch on.
 *
 * Skipped on Windows only: the step runs on `ubuntu-latest`, so a POSIX bash
 * is the faithful place to run it, and CI (also Ubuntu) always does.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW = readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');

/** The `run: |` body of the step carrying `id: <id>`, de-indented. */
function stepScript(id: string): string {
  const lines = WORKFLOW.split('\n');
  const at = lines.findIndex((line) => line.trim() === `id: ${id}`);
  if (at < 0) throw new Error(`release.yml has no step with id: ${id}`);

  const runAt = lines.findIndex((line, index) => index > at && line.trim() === 'run: |');
  if (runAt < 0) throw new Error(`the ${id} step has no run: | block`);

  const runIndent = (lines[runAt] as string).search(/\S/);
  const body: string[] = [];
  for (const line of lines.slice(runAt + 1)) {
    // A block scalar ends at the first non-blank line indented no deeper than
    // its key.
    if (line.trim() !== '' && line.search(/\S/) <= runIndent) break;
    body.push(line);
  }

  const indent = Math.min(
    ...body.filter((line) => line.trim() !== '').map((line) => line.search(/\S/)),
  );
  return body.map((line) => line.slice(indent)).join('\n');
}

interface Run {
  event: 'push' | 'workflow_dispatch';
  ref: string;
  /** The dispatch input; absent on a push, where `inputs.publish` is empty. */
  publish?: boolean;
  /** Whether `gh release view v<version>` finds the tag. */
  released?: boolean;
  key?: string;
}

const SHA = 'abc1234def5678abc1234def5678abc1234def56';

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function decide(run: Run): { outputs: Record<string, string>; log: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orderbook-release-check-'));
  scratch.push(dir);

  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  // `gh release view` answers "that tag exists" exactly when the case says so,
  // and `git rev-parse --short` answers with the short SHA.
  writeFileSync(path.join(bin, 'gh'), '#!/usr/bin/env bash\n[ "$STUB_RELEASED" = true ]\n', {
    mode: 0o755,
  });
  writeFileSync(path.join(bin, 'git'), `#!/usr/bin/env bash\necho ${SHA.slice(0, 7)}\n`, {
    mode: 0o755,
  });

  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  const script = path.join(dir, 'check.sh');
  writeFileSync(script, stepScript('version'));
  const output = path.join(dir, 'github-output');
  writeFileSync(output, '');

  // The shell GitHub Actions runs a `run:` step with.
  const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      HOME: dir,
      // The runner's own variables…
      GITHUB_OUTPUT: output,
      GITHUB_SHA: SHA,
      GITHUB_REF: run.ref,
      GITHUB_EVENT_NAME: run.event,
      // …and the step's `env:` block.
      GH_TOKEN: 'token',
      REPO: 'owner/orderbook-releases',
      RELEASE_KEY: run.key ?? '',
      EVENT: run.event,
      WANT_PUBLISH: run.publish === undefined ? '' : String(run.publish),
      STUB_RELEASED: String(run.released === true),
    },
  });

  expect(result.status, result.stderr).toBe(0);

  const outputs: Record<string, string> = {};
  for (const line of readFileSync(output, 'utf8').split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) outputs[line.slice(0, at)] = line.slice(at + 1);
  }
  return { outputs, log: result.stdout };
}

describe.skipIf(process.platform === 'win32')('the release check job', () => {
  it('publishes a version bump pushed to main', () => {
    const { outputs } = decide({ event: 'push', ref: 'refs/heads/main' });
    expect(outputs).toMatchObject({
      version: '9.9.9',
      build: 'true',
      publish: 'true',
      tag: 'v9.9.9',
    });
  });

  it('builds nothing for a push whose version is already released', () => {
    const { outputs } = decide({ event: 'push', ref: 'refs/heads/main', released: true });
    expect(outputs).toMatchObject({ build: 'false', publish: 'false' });
  });

  it('publishes a hand-run from main with publish ticked', () => {
    const { outputs } = decide({
      event: 'workflow_dispatch',
      ref: 'refs/heads/main',
      publish: true,
    });
    expect(outputs).toMatchObject({ build: 'true', publish: 'true', tag: 'v9.9.9' });
  });

  it('builds a draft for a hand-run without publish ticked', () => {
    const { outputs } = decide({
      event: 'workflow_dispatch',
      ref: 'refs/heads/dev',
      publish: false,
    });
    expect(outputs).toMatchObject({ build: 'true', publish: 'false', tag: 'build-9.9.9-abc1234' });
  });

  it('never publishes a hand-run from another branch, even with publish ticked', () => {
    // The defect: this created the real `v9.9.9` from `dev`'s commit.
    const { outputs, log } = decide({
      event: 'workflow_dispatch',
      ref: 'refs/heads/dev',
      publish: true,
    });

    expect(outputs).toMatchObject({ build: 'true', publish: 'false', tag: 'build-9.9.9-abc1234' });
    // Said out loud, not silently downgraded: somebody ticked the box.
    expect(log).toMatch(/^::warning::.*main/m);
  });

  it('never publishes a hand-run from a tag either', () => {
    // `workflow_dispatch` can be pointed at a tag as well as a branch; only
    // main's tip is a release.
    const { outputs } = decide({
      event: 'workflow_dispatch',
      ref: 'refs/tags/v9.9.8',
      publish: true,
    });
    expect(outputs).toMatchObject({ build: 'true', publish: 'false', tag: 'build-9.9.9-abc1234' });
  });

  it('builds a draft rather than republishing a version that is already out', () => {
    const { outputs, log } = decide({
      event: 'workflow_dispatch',
      ref: 'refs/heads/main',
      publish: true,
      released: true,
    });
    expect(outputs).toMatchObject({ build: 'true', publish: 'false', tag: 'build-9.9.9-abc1234' });
    expect(log).toMatch(/^::warning::v9\.9\.9 is already released/m);
  });

  it('marks the run unsigned exactly when there is no RELEASE_KEY', () => {
    expect(decide({ event: 'push', ref: 'refs/heads/main' }).outputs.signed).toBe('false');
    expect(decide({ event: 'push', ref: 'refs/heads/main', key: 'PEM' }).outputs.signed).toBe(
      'true',
    );
  });
});
