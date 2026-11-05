---
id: 7249
title: "IR claim ledger: per-file rows and a zero-legacy predictor for `ir_only_pass` in `--wrapped` mode"
status: in-progress
sprint: current
created: 2026-11-05
updated: 2026-11-05
priority: high
horizon: s
feasibility: easy
reasoning_effort: high
task_type: tooling
area: ir
goal: ir-full-coverage
related: [7240, 7106, 6806]
assignee: "ttraenkler/c-lead"
---

# #7249: the wrapped ledger cannot say which files are close to IR-only

## Problem

The real metric for "test262 on the IR path" is `summary.ir_only_pass`
(`scripts/build-test262-report.mjs`, ~L1140): a standalone pass whose compile
has `ir_legacy_units === 0`. It is 1088 / 48,232 on main. It only moves when
EVERY unit of a file, harness included, ships an IR body.

`scripts/ir-claim-ledger.mts --wrapped` (#7240) compiles files exactly as the
runner does, but reports only aggregate tallies. Nobody can see, per file,
which legacy units remain, or how many files are already zero-legacy.

## Implementation Plan (C lead, 2026-11-05)

- **Module.** New `scripts/ir-claim-ledger-files.mts` owns the per-file row
  and the histogram (one concern). `scripts/ir-claim-ledger.mts` only collects
  rows in `tallyCompile`, merges them, and writes them.
- **Reuse.** "Legacy unit" is the worker's definition
  (`summarizeIrRoute`, `scripts/test262-worker.mjs`): no IR body ⇒ legacy; IR
  body + direct body ⇒ `both` (counts as IR); `non-executable` is not a unit.
  Origin reuses #7240's `unitOrigin`.
- **Channel.** Workers carry rows in the partial population they already
  return; only the parent writes `--files-json`.
- **Output.**
  - `--files-json <path>` (repo-relative, wrapped only): one row per compiled
    file, `{file, compileOk, units, legacyUnits:[{name, origin, kind,
    firstRefusal?}], irUnits, bothUnits}`. `firstRefusal` appears only under
    `JS2WASM_IR_SHAPE_DIAG=1`.
  - Wrapped summary (`--out` JSON and stdout): `zeroLegacyFiles` and
    `legacyUnitHistogram` (`{"0","1","2","3","4+"}`), over files that
    compiled (only those can become `ir_only_pass` rows). The rows themselves
    are not in `--out`.
- Raw mode stays byte-identical.

## Acceptance criteria

- `--wrapped --files-json` writes the rows; summary carries the two fields.
- Raw mode byte-identical (stride-400 raw run on base and head, timing and
  commit fields stripped).
- Test `tests/issue-7249-ir-claim-ledger-files-json.test.ts`: row shape;
  histogram sums to the compiled-file count.
- Quality: no duplicated legacy predicate beyond the worker's (which is `.mjs`
  in the runner lane and cannot be imported from here without moving it); no
  change under `src/`.
- Measured: stride 40, standalone, `--jobs 2`; numbers in the PR body.
