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

## Implementation Plan

Owner: lane S25 (lead decision, 2026-11-26). The plan is reviewed before any code.

### Target structure

- **New module `scripts/test262-native-drain.mjs`.** It sits beside the other shared runner/worker modules
  (`test262-import-object.mjs`, `negative-verdict.mjs`, `test262-runtime-verdict.mjs`), which
  `tests/test262-runner.ts` already imports from `scripts/`. It exports two functions:
  - `drainAndCaptureNativeStdout(exports, peers, append)`: the worker's current body, moved unchanged, with
    `currentLinkedPeers` passed in instead of read from module state. It returns the first drain error or `null`.
  - `captureNativeStdout(exports, append)`: moved unchanged.
- **`scripts/test262-worker.mjs`.** Delete both functions and import them. The one call site (~L2734) passes
  `currentLinkedPeers`. This is a pure move: same calls in the same order, same error handling.
- **`tests/test262-runner.ts` `runOriginalHarnessVariant` (~L4579–4612).**
  - Replace the hand-copied drain and stdout block with one call to the shared helper, passing `[]` for peers (the
    in-process runner has no linked peers).
  - Change the condition from `target === "standalone" && meta.flags?.includes("async")` to
    `meta.flags?.includes("async")`, the same keying the worker uses since #6685. The helper is feature-detected on
    the exported intrinsics.
  - Rename `standaloneDrainError` to `drainError`; its later use is unchanged.
- **Duplicates removed.** Four copies of the drain/stdout loop become one: the worker's, the runner's, and the two
  "reduced" copies in `tests/issue-6723-standalone-linked-{print,errors}.test.ts`. The 6723 tests call the shared
  helper instead of their local `drainAndRead`, keeping their assertions.

### What does not change

- **Published verdicts.** The worker change is a move with identical behaviour, so CI's standalone and linked
  measurements stay untouched.
- **Verdict scoring.** It is not a verdict-logic change: the marker poll, the timeout and the pass/fail rules are
  untouched.
- **No `src/` change.**

### Acceptance criteria

1. **Flip list.** Run all 280 root test files that call `runTest262File` on base (main) and on the branch, single fork,
   each file alone; the results are JSON reports. Report every per-test flip (fail→pass, pass→fail) in the PR body.
   **pass→fail must be 0.** The expected fail→pass is JS-target async rows that stopped at "async completion marker not
   observed".
2. **issue-1363.** `tests/issue-1363.test.ts`, with its test262 path fixed (repo-relative `TEST262_ROOT`, as in #7494),
   passes on the default target. The path fix ships in this PR.
3. **Worker equivalence.** Run the two 6723 tests and a `TEST262_PATH_FILTER` run of 20 async test262 files through
   `scripts/run-test262-vitest.sh`, standalone and honest lanes, before and after. Row status, error and output must
   be identical.
4. **Quality.**
   - One drain helper, zero copies left (`rg "__stdout_char\(" tests scripts` shows only the helper and fixtures that
     test it).
   - No new single-use abstraction.
   - The ratchet gates pass.
   - A fresh-context adversarial review verdict is recorded in the PR.

### Risks

- **New failures behind the marker.** Rows that used to stop at "marker not observed" may now complete and fail with
  `AsyncTestFailure`. Those are pre-existing semantic failures that were hidden before, not regressions. Any such
  pass→fail is investigated and reported, not accepted silently.
- **Blast radius.** 280 files. The before/after run is the guard; no expectation is changed to absorb a flip.

## Not in scope

File 2 fails in the linked lane (`value is not iterable`) while the honest lane and standalone pass it. The linked
lane is host-only (JS-host sunset), so that failure is not chased here; it gets its own issue if wanted.
