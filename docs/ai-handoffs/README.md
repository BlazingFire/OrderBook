# AI handoff briefs

One file per task, written by whichever agent scoped the work (usually
Claude, per `docs/AI_COLLABORATION.md`) for whichever agent implements it
(Command Code or Qwen 3 via OpenCode). Follow `docs/AI_COLLABORATION.md` §5:

1. **The brief** (written by the planner): the goal in one paragraph, the
   exact files to touch, what "done" looks like (which tests to run, what
   output is expected), and any constraints (offline-only, don't touch
   migrations, etc.).
2. **One named owner** for implementation, one for review.
3. **The implementer appends to the same file** — what changed, what was
   verified (`npm run verify` output or the relevant subset), what's left.
   The next agent reads this file, not a chat transcript.
4. Once a brief is done, fold anything durable into `HANDOFF.md` and delete
   or archive the brief — this directory is a working queue, not a permanent
   record.

Name files `<short-task-slug>.md`. Keep exactly one open brief per task so
two agents don't pick up the same work.
