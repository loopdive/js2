---
id: 7240
title: "IR claim ledger: opt-in `--wrapped` mode that compiles test262 files exactly as the standalone runner does"
status: done
sprint: current
created: 2026-11-05
updated: 2026-11-05
completed: 2026-11-05
priority: high
horizon: s
feasibility: easy
reasoning_effort: high
task_type: tooling
area: ir
goal: ir-full-coverage
related: [7124, 7106, 3523, 2949]
assignee: "ttraenkler/c-lead"
---

# #7240: the IR claim ledger measures a program the runner never compiles

## Problem

`scripts/ir-claim-ledger.mts` compiles every sampled test262 file **raw**,
without the harness. Real standalone runs go through `wrapTest(source, meta,
target)` in `tests/test262-runner.ts`, which adds the preamble (`assert`,
`$262`, the `includes:`) and the test-body rewrites.

The 2026-11-05 module-init census (#6583 comment 6649692194, stride 40,
standalone) shows the effect:
- `assert` is "not in scope" in 569 of 982 refused module-init units;
- it is the first refusal for 162 of them, and the only refusal for 124.

The ledger therefore over-reports one blocker that does not exist in the real
lane. It also cannot see blockers that only exist in the real lane: harness
function units, and the call-graph closure against harness calls. So every
IR-coverage claim measured with it is on the wrong program.

## Implementation Plan (C lead, 2026-11-05; implement on Opus)

1. **Add an opt-in `--wrapped` flag** to `scripts/ir-claim-ledger.mts`. With
   the flag, each test262 file is compiled as
   `wrapTest(source, parseMeta(source), target).source`, with the same compile
   options the runner uses for that target. Import `wrapTest`, `parseMeta` and
   the option builder from `tests/test262-runner.ts` rather than copying them.
   If the runner's option assembly is not exported, export a small pure helper
   from the runner instead of duplicating the logic.
   - Skip exactly the files the runner skips (`shouldSkip`, negative tests via
     `buildNegativeCompileSource`?). Decide, then document the decision in the
     script header and in the JSON output.
   - Leave the playground corpus unchanged: it has no harness.
2. **Keep raw mode the default.** Raw output must be byte-identical to today's
   for the same commit. CI and other lanes may depend on it.
3. **Label the output.** Add a `mode: "raw" | "wrapped"` field to the JSON and
   print the mode in the summary line, so the two can never be compared by
   accident.
4. **Attribute units correctly.** In wrapped mode, harness units (preamble
   functions) appear in every file. Tag each unit as `harness` or `test` by
   source position: the wrap result has `bodyLineOffset`. Report both totals.
   Otherwise harness units, repeated 1340 times, swamp the test units.
5. **Measure.** Run both modes at stride 40 on standalone, on the same commit,
   and put the two summaries in the PR body:
   - routes;
   - `unsupportedByStageCode`;
   - harness units vs test units.

   The point is a trustworthy baseline for every lane, not a code change in
   the compiler.

## Acceptance criteria

- `--wrapped` runs to completion (stride 40, standalone, `--jobs 2`), with 0
  invariants.
- Raw mode is unchanged. Prove it with a stride-40 raw run, comparing the JSON
  apart from timing fields.
- Test: `tests/issue-7240-ir-claim-ledger-wrapped.test.ts` covers one tiny test262
  file under both modes:
  - in raw mode, `assert` is refused as not-in-scope;
  - in wrapped mode, there is no such refusal, and the harness/test unit split
    is present.
- No change under `src/`.

## Implementation notes (2026-11-05)

- **Deviation from step 1, on purpose:** wrapped mode compiles
  `assembleOriginalHarness(source, meta).primary.source`, not `wrapTest(...)`.
  `runTest262File` and the sharded CI worker have compiled the literal harness
  assembly since #3370; the runner marks `wrapTest` deprecated ("not a
  conformance verdict oracle"). Using it would have measured a second program
  the runner never compiles.
- Options come from the new pure export `originalHarnessCompileOptions(meta,
  target)` in `tests/test262-runner.ts`, which `runOriginalHarnessVariant` now
  calls too (same object, moved, not copied).
- Skips: non-negative files that `shouldSkip` rejects (counted under
  `skipped`/`skippedReasons`). Negative tests compile through the same
  assembly, as `runTest262File` does; `buildNegativeCompileSource` belongs to
  the legacy synthetic runner only.
- Not modelled: the strict-rerun variant, the Temporal provider prelude, and
  the compileMulti self-import route for `module-code/namespace/`.
- Origin: `<module-init>` is always `test`; other units are `test` iff
  `line > bodyLineOffset`.
- `JS2WASM_IR_SHAPE_DIAG=1` adds `unsupportedDetails` (first refusal per unit);
  absent otherwise.
- Test: `tests/issue-7240-ir-claim-ledger-wrapped.test.ts`.
- Caveat: `<module-init>` covers the harness's top-level code too, so a
  test-tagged module-init refusal can sit in a harness include (e.g.
  `floatArrayConstructors = [...]`). The row carries no refusal position.
