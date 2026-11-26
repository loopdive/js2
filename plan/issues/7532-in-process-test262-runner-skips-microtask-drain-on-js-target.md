---
id: 7532
title: "In-process test262 runner drains the in-module microtask ring only on standalone; JS-target async root tests never complete"
status: ready
sprint: current
created: 2026-11-26
updated: 2026-11-26
priority: medium
horizon: s
feasibility: easy
reasoning_effort: high
task_type: bugfix
area: test-infra
goal: core-semantics
related: [1363, 3469, 6685, 6708]
---

# #7532: `runTest262File` never drains microtasks on the JS target

## Problem

`tests/issue-1363.test.ts` runs two test262 files through the in-process runner `runTest262File`
(`tests/test262-runner.ts`):

- `language/expressions/class/dstr/async-gen-meth-static-dflt-obj-ptrn-empty.js`
- `language/expressions/class/dstr/async-private-gen-meth-dflt-ary-init-iter-no-close.js`

Both fail with `async completion marker not observed`.

Lane S25 measured on main `1a726b3e` (2026-11-26) that this is not a compiler regression:

| path | file 1 | file 2 |
|---|---|---|
| sharded worker, honest lane (`scripts/run-test262-vitest.sh` + `TEST262_PATH_FILTER`) | pass | pass |
| sharded worker, `TEST262_ORACLE_MODE=linked` | pass | fail: `Test262:AsyncTestFailure:TypeError: value is not iterable` |
| `runTest262File(…, "standalone")` | pass | pass |
| `runTest262File(…)` default (JS) target | no marker | no marker |

## Cause

Since #6708 S6 (native-first default), JS-target modules keep async continuations on the in-module microtask ring, as
standalone does.

- The worker, `scripts/test262-worker.mjs` `drainAndCaptureNativeStdout`, always calls `__drain_microtasks()` when the
  module exports it (#6685, 3a91a996e, 2026-09-26).
- The in-process runner, `runOriginalHarnessVariant` (~L4588), still gates the drain on
  `target === "standalone" && meta.flags?.includes("async")` (#3469, a71613b8c). So on the JS target the
  `.then($DONE, $DONE)` callbacks never run.

Probe: the same assembled harness, compile options and imports, with only the drain call toggled. Without the drain the
output is `[]`. With it the output is `["Test262:AsyncTestComplete"]` for both files.

The "pass" rows in `.test262-cache/test262-current.jsonl` are the frozen JS-host snapshot (12.10.2026,
`semantic_providers: "auto"`), not current evidence. The current standalone baseline (26.11.2026) passes both files.

## Implementation plan

- **Module:** `tests/test262-runner.ts` `runOriginalHarnessVariant`. Test infrastructure only; published verdicts come
  from the worker and do not change.
- **Change:** key the drain and native-stdout mirror on async rows plus the exported intrinsics, as the worker does,
  and drop the `target === "standalone"` condition.
- **Reuse:** the worker already has this logic (`drainAndCaptureNativeStdout`, in an `.mjs`). Prefer one shared helper
  that both import over a second copy; two copies are how this drifted.
- **Blast radius:** 280 root test files call `runTest262File`. Run every one of them before and after, and report the
  flips. Expected: JS-target async rows that stopped at "async completion marker not observed" now complete. Any
  pass→fail flip is investigated before landing.
- **Acceptance:**
  - `tests/issue-1363.test.ts`, with its path fixed, passes on the default target. The path fix is the `TEST262_ROOT`
    change from lane S25's class-E work, saved at `.claude/worktrees/s25-root-e1/.tmp/issue-1363.fixed.ts`, and it
    ships with this fix.
  - No root test flips pass→fail.
  - One drain helper shared by the worker and the in-process runner.

## Not in scope

File 2 fails in the linked lane (`value is not iterable`) while the honest lane and standalone pass it. The linked
lane is host-only (JS-host sunset), so that failure is not chased here; it gets its own issue if wanted.
