---
id: 5172
title: "Four rotted test rows fail on current main but never run in CI (fix-on-touch ratchet blind spot): #3529 dataflow unary `!` ×2, #3529 externref console identity, #3522 standalone console parity"
status: ready
sprint: current
created: 2026-08-29
updated: 2026-08-29
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: ir, tests
goal: ir-full-coverage
related: [3529, 3522, 5092]
origin: "2026-08-29 PR #5102 drive-to-green — clean merge-base attribution during the issue-4502 fix-on-touch repair"
---

# #5172 — four rotted test rows, red on main, never run in CI

## Problem

During PR #5102's drive-to-green (commit `7fb7dc2b` on
`codex/5092-ir-conditional-expression`), a clean attribution pass found four
test rows that fail on a tree byte-identical to origin/main's source (verified:
the branch's merge-base `33099f2` has an EMPTY `git diff … origin/main -- src/
scripts/`), reproduced with CI's own vitest flags
(`--pool=forks --singleFork --no-file-parallelism`):

1. `#3529` dataflow unary `!` — two rows;
2. `#3529` externref console identity — one row;
3. `#3522` standalone console parity — one row.

Counts: 4 failed / 47 passed across their files, identical at the clean
merge-base and at the PR branch head.

## Why CI is green anyway

`ci.yml`'s changed-root gate runs ONLY the `tests/*.test.ts` files a PR
touches ("Untouched root test files do NOT run at PR time … touching a rotted
one means fixing it — the fix-on-touch ratchet"). Nothing on main touches
these files, so the rot is invisible until someone edits them — at which point
the editor inherits four unrelated failures (this nearly cost PR #5102 a
second CI cycle).

## What to do

1. Reproduce each row on current main with CI's vitest flags; classify: stale
   expectation (product moved, pin not updated) vs real regression (find the
   introducing commit — `git log -S` on the asserted strings).
2. Fix product or pin per classification; each edited file then enters the
   fix-on-touch ratchet, so the WHOLE file must be green.
3. Deliberately left out of PR #5102 to avoid widening it — this issue is the
   tracked follow-up.

## Acceptance criteria

- The four rows green on main under CI's flags, with the rest of their files
  green (fix-on-touch).
- Each fix's classification stated (stale pin vs regression + introducing
  commit).
- Ratchet gates chained bare before commit.
