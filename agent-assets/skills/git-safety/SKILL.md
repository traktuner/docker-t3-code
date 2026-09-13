---
name: git-safety
description: Go/no-go safety verdict procedure around any change set - snapshots, destructive-command checks, diff-size and dependency guardrails. Load before finalizing any implementation work, and always when a change feels large or risky.
---

# Git Safety Review — Go/No-Go Procedure

Run this around any non-trivial change set. Output is a verdict: GO / NO-GO with reasons.

## Procedure

1. **Snapshots:** `git status --short` must exist from BEFORE the change; take the AFTER now.
   Diff the two mentally: are there touched files that do not belong to the task? Unrelated
   changes → NO-GO until separated.
2. **Size:** `git diff --stat`. More than **20 files or 1000 lines** → STOP: NO-GO for automatic
   continuation; require an independent review and explicit user confirmation.
3. **Destructive-command audit:** confirm none of these ran without an explicit user request:
   `git reset --hard`, `git clean -fdx`, force-push, branch/stash deletion, `rm -rf`.
   Check `git reflog -5` if uncertain about history manipulation.
4. **VCS actions:** confirm nothing was committed, pushed, merged, or tagged without an explicit
   in-session user request (`git log --oneline -3` vs. session start).
5. **Dependencies:** grep the diff for manifest/lockfile changes (`package.json`,
   `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `Cargo.*`, `go.mod`, `go.sum`,
   `requirements*.txt`, `Pipfile*`, `pyproject.toml`, `Gemfile*`, `composer.*`, Dockerfile FROM
   lines). Any hit → explicit call-out in the report (supply-chain risk), never silent.
6. **Verification:** were tests/build run? If not, is the exact reason stated (missing dep, no
   network, no harness, secret required)? Unverified + unexplained → NO-GO.

## Verdict format

`GO` or `NO-GO` · one line per checked item (pass/fail) · required follow-ups.
Not a git repo? Report that and offer `git init`; do not fabricate the checks.
