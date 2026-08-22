# Vendored skill — do not edit by hand

This directory is a **third-party skill copied verbatim** into the repo so that
every Claude Code session on this project has it available without a separate
install step.

| | |
|---|---|
| Upstream | https://github.com/dickwu/apple-design-skill |
| Commit | `d0bac1e765a27a696839e62962e36330ce72f0b7` |
| Vendored on | 2026-08-22 |
| Contents | `SKILL.md`, `references/hig-lookup.md`, `references/hig/` (53 docs) |

Upstream's `README.md`, `AGENTS.md` and `.cursorrules` are intentionally **not**
vendored — they target other editors and would only add noise to the skill's
context window.

## What it is

A UI/UX design review methodology derived from Apple's Human Interface
Guidelines, generalized to any mobile or desktop framework. Relevant here for
the Phase 2 visual polish pass over the two React frontends (`master/web`,
`office/web`) — see `HANDOFF.md`.

## Updating it

Re-copy from upstream rather than editing in place, then update the commit
hash above:

```bash
git clone https://github.com/dickwu/apple-design-skill.git /tmp/apple-design-skill
cp /tmp/apple-design-skill/SKILL.md .claude/skills/apple-design/
rm -rf .claude/skills/apple-design/references
cp -r /tmp/apple-design-skill/references .claude/skills/apple-design/
```

Review the diff before committing an update: a skill's contents steer assistant
behaviour, so changes deserve the same scrutiny as changes to source code.

## Licensing

The guidelines are derived from Apple's publicly available HIG documentation.
Upstream states "use at your own discretion" and ships no formal licence file —
worth a look from whoever owns licensing for this project before the app ships
commercially.
