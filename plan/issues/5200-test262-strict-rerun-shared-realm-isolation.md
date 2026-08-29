---
id: 5200
title: "test262 runner: in-process strict rerun breaks on non-configurable keys added to shared host builtins"
status: ready
sprint: current
created: 2026-08-29
updated: 2026-08-29
priority: medium
horizon: s
feasibility: medium
task_type: test-infra
area: test-infra
es_edition: ES2015
goal: standalone-mode
requested_by: claude/fable-es2015
---

# #5200 — strict-rerun isolation for non-configurable additions to shared builtins

## Problem

The one REAL reproducible regression found in the 2026-08-29 merge-queue
drift investigation (everything else was baseline drift / shard artifacts):

`built-ins/String/prototype/match/cstm-matcher-on-boolean-primitive.js` —
the sloppy variant now genuinely installs a **non-configurable accessor** on
the shared host `Boolean.prototype` (before the session's fixes, the compiled
`defineProperty` was silently dropped, so the pollution never happened). The
in-process strict rerun in the same worker then throws
`Cannot redefine property: Symbol(Symbol.match)`.

`tests/test262-restore-builtins.ts` cannot delete a non-configurable added
key, and the worker lane recycles the fork for this test class — so the
correctness fix (defineProperty actually working) surfaces as a runner-lane
false failure. This will recur for ANY test that defines a non-configurable
property on a shared host builtin in the sloppy pass.

## Options (pick one in the planning step)

1. **Fork-recycle-equivalent isolation for the in-process strict rerun**: when
   the restore pass detects an undeletable added key, mark the worker
   poisoned and route the strict rerun (and subsequent tests) to a fresh
   fork — mirrors what the fork-recycling lane already does, scoped to the
   in-process path.
2. **Detect-and-flag**: restore-builtins reports the undeletable key; the
   runner records the strict rerun as `skipped-shared-realm` instead of
   `fail`, and the classification is surfaced in the report (keeps the lane
   fast, accepts a small accuracy loss, documented).

Option 1 is the correct fix; option 2 is the cheap stopgap. Either must NOT
change skip semantics for any other class (the skip-filter list in CLAUDE.md
is load-bearing — re-verify against `tests/test262-runner.ts` before and
after).

## Acceptance criteria

- `cstm-matcher-on-boolean-primitive.js` passes (or is explicitly
  `skipped-shared-realm`-classified, option 2) with the sloppy-pass
  defineProperty fix in place; no other test's skip/run classification
  changes.
- The undeletable-key condition is detected generically (any shared builtin,
  any symbol/string key), not special-cased to `Symbol.match`.

## References

- Handover `plan/agent-context/es2015-standalone-session-handover.md`
  ("Merge-queue situation") — full diagnosis and measurements.
- `tests/test262-restore-builtins.ts`, `tests/test262-runner.ts` (strict
  rerun + fork-recycle lanes).
