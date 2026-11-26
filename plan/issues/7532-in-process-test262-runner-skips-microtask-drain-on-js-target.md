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

Owner: lane S25 (lead decision, 2026-11-26). Revised after the plan review (PRV BLOCKER on `9e876ee467`, 5 text points).

### Copy inventory (measured on main `a9cdc885`)

The drain-and-sink logic exists in five harness places, plus four test-side "reduced" mirrors:

| # | where | what it is | plan |
|---|---|---|---|
| 1 | `scripts/test262-worker.mjs` `drainAndCaptureNativeStdout` / `captureNativeStdout` (~L1852–1912) | production, sharded worker | moved into the new module unchanged |
| 2 | `scripts/test262-worker.mjs` `standaloneLinkedPeers` (~L1919) | production peer lookup | moved into the new module unchanged |
| 3 | `tests/test262-runner.ts` `runOriginalHarnessVariant` (~L4579–4612) | in-process runner; the bug is here | replaced by a call |
| 4 | `tests/test262-shared.ts` (~L1124–1160) | production, #3496 multi-module fixture path | replaced by a call |
| 5 | `tests/issue-6723-standalone-linked-{print,errors}.test.ts` `drainAndRead` | reduced mirror of 1 (linked rounds) | folded onto the helper |
| 6 | `tests/issue-6685.test.ts` `readSink` (L48–55) | reduced mirror of 1 (single module) | folded onto the helper |
| 7 | `tests/issue-3469-standalone-async-completion-sink.test.ts` `drainAndReadSink` (L40–50) | reduced mirror of 1 | folded; its `"<no sink exports>"` sentinel stays as an explicit check before the call |

**Not copies, and left alone:** the embedder drains in `issue-6685.test.ts` L91 and L126. Those tests drive
`__drain_microtasks` and then observe the console capability; the drain call is the behaviour under test, not a harness
mirror.

### Target structure

- **New `scripts/test262-native-drain.mjs`.** It sits beside the shared modules `tests/test262-runner.ts` already imports
  (`test262-import-object.mjs`, `negative-verdict.mjs`) and exports:
  - `linkedPeerExports(target, result, importObj)` (rows 1–2: the worker's `standaloneLinkedPeers`, renamed for what it
    returns);
  - `drainAndCaptureNativeStdout(exports, peers, append)`;
  - `captureNativeStdout(exports, append)`.

  All are moved unchanged; `peers` is a parameter instead of the worker's `currentLinkedPeers` module state.
- **Worker.** It deletes rows 1–2 and imports them. Same calls in the same order. This is a pure move.
- **Runner** (row 3).
  - Condition: `meta.flags?.includes("async")`, keyed like the worker since #6685, instead of
    `target === "standalone" && …async`.
  - Peers: `linkedPeerExports(target, result, imports)`. The runner does instantiate `result.linkedModules`, so it now
    drains linked peers exactly as the worker does. There is no divergence left.
  - Rename `standaloneDrainError` to `drainError`.
- **`test262-shared.ts`** (row 4): the same call, with the same peer lookup for its multi-module fixture. Passing
  peers is a no-op unless the fixture row has `result.linkedModules` (Temporal, #5248), and the lookup returns `[]`
  off standalone. One of the 10 fixture rows in acceptance 3 is chosen to confirm the output is identical.
- **Tests** (rows 5–7): call the helper. **The 6723 tests assert `drainError === null`**, which keeps them as strict as
  the throwing original.

### What does not change

- Verdict scoring: marker poll, timeout and pass/fail rules.
- No `src/` change.
- Published standalone and linked CI measurements: the worker change is a move with identical behaviour; see acceptance 3.

### Acceptance criteria

1. **Flip list.** `rg -l runTest262File tests` lists 283 files: 280 test files plus three modules that are not tests
   (`test262-runner.ts`, `test262-oracle-version.ts`, `test262-restore-builtins.ts`). All 280 test files are run on
   base (main) and on the branch: one vitest process per file, single fork, JSON report. Each file runs under an
   external wall timeout of 15 min (`timeout 900`). A file that hits the timeout or exits without a report counts as a flip.
   - Report every per-test flip (fail→pass, pass→fail, *→hang) in the PR body.
   - pass→fail and *→hang must be 0.
   - Expected fail→pass: the JS-target async rows that stopped at "async completion marker not observed", among them
     `tests/issue-1363.test.ts`. Its repo-relative `TEST262_ROOT` path fix ships here.
2. **No copies left.**
   - Check, matching code only, not comments: `rg -l '\.__drain_microtasks\b' tests scripts | xargs rg -l '\.__stdout_char\b'`.
     It still catches the aliased form `(exp.__drain_microtasks as () => void)()` and `exp.__stdout_char as …`.
   - Allowed hits after the change:
     - `scripts/test262-native-drain.mjs`, the one implementation.
     - The frozen instruments `scripts/lib/fixtures/frame-delay-original-instruments/*.txt`, which must not change.
     - The embedder tests that compile their own module and read its sink as the behaviour under test:
       `tests/equivalence/issue-6995-*`, `issue-6996-*`, `tests/helpers/native-delay-combinator-source-receipts.mjs`,
       `tests/issue-3518-async-frame-body-source-preservation`, `issue-3542`, `issue-3548`, `issue-4574-*`.
     - `tests/issue-6685.test.ts`: its L91/L126 drains are embedder calls under test (they drive `__drain_microtasks`,
       then observe the console capability). Only its `readSink` mirror is folded.
   - `test262-worker.mjs`, `test262-runner.ts`, `test262-shared.ts`, the 6723 tests and the 3469 test must not appear.
     The 3469 comments that name the intrinsics are reworded so the code-only check stays exact.
3. **Worker equivalence.** Before and after, run `scripts/run-test262-vitest.sh` with `TEST262_PATH_FILTER` on 20 async
   test262 files: 10 single-module and 10 multi-module fixture rows (`_FIXTURE` imports). Do this in the standalone and
   honest lanes, and once with `TEST262_ORACLE_MODE=linked`. Row `status`, `error` and output must be identical. The
   6723, 6685 and 3469 tests must pass.
4. **Quality.**
   - One implementation.
   - No new single-use abstraction (the module has 4 importers).
   - The ratchet gates pass.
   - A fresh-context adversarial review verdict is recorded in the PR.

### Risks

- **Hidden failures surface.** Rows that stopped at "marker not observed" may now complete and fail with
  `AsyncTestFailure`. They are listed, not absorbed. A pass→fail blocks landing until investigated.
- **Hangs.** A continuation that re-enqueues itself could spin the in-process drain. The external per-file timeout
  catches that, and it counts as a flip.

## Not in scope

File 2 fails in the linked lane (`value is not iterable`) while the honest lane and standalone pass it. The linked
lane is host-only (JS-host sunset), so that failure is not chased here; it gets its own issue if wanted.
