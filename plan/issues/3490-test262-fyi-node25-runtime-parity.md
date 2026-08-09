---
id: 3490
title: "Test262 FYI comparisons must use the same Node 25 and Unicode 17 host runtime as CI"
status: done
sprint: 73
created: 2026-07-20
updated: 2026-07-21
completed: 2026-07-20
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: infrastructure
area: test262-runner
goal: ci-reliability
lane: A
related: [3370, 3425, 3473]
files:
  - package.json
  - scripts/run-test262-fyi.mjs
  - scripts/test262-fyi-runtime.mjs
  - tests/issue-3490-test262-fyi-runtime-parity.test.ts
---

# #3490 — Test262 FYI comparisons must use the same Node 25 and Unicode 17 host runtime as CI

## Problem

The project Test262 baseline is generated in CI under Node 25, but the completed
local test262.fyi original-harness host run used Node 24.4.1 (V8 13.6, ICU 77.1,
Unicode 16.0). The FYI host lane exposes built-ins from its Node VM realm, so
different Node/ICU/Unicode capabilities change test verdicts even when js2wasm
emits identical code.

This created 104 runtime-only false project-pass/FYI-fail rows in the
current-main targeted comparison:

- 84 Unicode 17 RegExp/property-escape tests;
- 20 `Uint8Array` base64/hex API or behavior tests.

The current FYI report records `process.version`, V8, ICU, and Unicode versions,
but the command permits an incompatible host and still presents the resulting
numbers as comparable. Package-wide Node support must not be raised just to run
this optional conformance lane; the restriction belongs to authoritative FYI
comparison runs.

## Evidence (2026-07-20)

- Test262 and `test262-fyi/data` revisions match exactly between the two
  compared reports.
- Rebased current-main targeted host run: **864/970 pass**, with 104 failures
  in the runtime-dependent groups above. The other two failures are duplicate
  `isPrimitive` declarations owned by #3489.
- CI Test262 workflows and baseline refresh jobs explicitly install Node 25.
- Local Node 24.4.1 reports Unicode 16.0/ICU 77.1; Node 25.9.0 reports Unicode
  17.0/ICU 78.2.
- The other 864 apparent host gaps pass after current compiler/runner fixes,
  proving that they were revision skew rather than current harness differences.

## Acceptance criteria

- Define one authoritative FYI-comparison runtime contract matching the
  project baseline: Node major 25 with Unicode 17 capabilities.
- A command intended to produce a comparable FYI report must either run under
  that runtime or fail before compiling tests with a clear remediation command.
- Keep ordinary package use and non-authoritative developer smoke samples
  available on the repository's supported Node range; do not globally change
  the package engine floor to Node 25.
- Validate capabilities that affect observed verdicts, not only a version
  string: Unicode 17 RegExp data and the required `Uint8Array` base64/hex APIs.
- Persist the validated runtime contract and actual Node/V8/ICU/Unicode values
  in the report so comparisons can reject incompatible artifacts.
- Any scheduled or manual FYI workflow uses the same explicit Node 25 setup as
  Test262 baseline CI.
- Add focused tests for accepted Node 25 capabilities, rejection of the known
  Node 24 shape, opt-in non-authoritative smoke behavior, and report metadata.
- Under the authoritative runtime, the 104 environment-only rows no longer
  count as js2wasm or harness regressions.

## Validation

- Run the runtime-contract unit tests with mocked Node/ICU/Unicode capability
  records.
- Run the 104-path targeted FYI host sample under Node 25 and confirm its
  verdicts match the project baseline.
- Run the authoritative command under Node 24 and confirm it fails before the
  compiler pool starts, with no misleading final report.

## Implementation Summary

### What was done

- Added `scripts/test262-fyi-runtime.mjs`, which defines the versioned
  `test262-fyi-node25-unicode17-v1` contract and validates Node major 25,
  Unicode major 17, real `Script=Beria_Erfe` RegExp data, and behavior of all
  six required `Uint8Array` base64/hex APIs.
- Made `test:262:fyi` run the authoritative preflight before building the
  compiler bundle. Direct runner invocations repeat the preflight before test
  discovery, harness loading, or compilation.
- Added `test:262:fyi:smoke` / `--non-authoritative-smoke` for developer
  samples. Its console warning and JSON metadata both state that the artifact
  is non-authoritative and non-comparable, even if the host happens to satisfy
  the contract.
- Added the complete required contract, detected Node/V8/ICU/Unicode versions,
  individual API availability, capability results, and mismatches to each FYI
  report under `runtimeContract`.
- No scheduled or manual FYI workflow entry currently exists, so no workflow
  file needed changing. Existing Test262 baseline workflows already select
  Node 25 explicitly.

### What worked

- Keeping validation in an isolated module made accepted/rejected runtime
  shapes testable without compiling or loading Test262.
- The Node 24.4.1 preflight reports all four incompatibility categories and
  exits before `build:compiler-bundle`; direct runner rejection writes no JSON
  report.
- A Node 24 smoke run remained available and produced a report with
  `authoritative: false` and `comparable: false`.

### What did not work

- The original 106-row attribution included two duplicate-`isPrimitive`
  failures owned by #3489. Comparing exact paths corrected this issue's runtime
  scope to 104 rows: 84 Unicode 17 plus 20 Uint8Array base64/hex.

### Files changed

- `package.json`
- `scripts/run-test262-fyi.mjs`
- `scripts/test262-fyi-runtime.mjs`
- `tests/issue-3490-test262-fyi-runtime-parity.test.ts`
- `plan/issues/3490-test262-fyi-node25-runtime-parity.md`

### Validation

- `pnpm exec vitest run tests/issue-3490-test262-fyi-runtime-parity.test.ts tests/test262-fyi-runner.test.ts --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism`
  — 9/9 tests passed.
- Node 24.4.1 authoritative package command — exited 1 during preflight before
  the compiler bundle was created; direct runner invocation also exited 1 and
  wrote no report.
- Node 24.4.1 explicit smoke sample — 1/1 passed and emitted non-authoritative,
  non-comparable runtime metadata.
- Node 25.9.0 real preflight — exited 0 after the Unicode 17 and Uint8Array
  behavior probes; an authoritative 1/1 sample emitted `comparable: true` with
  the actual V8 14.1, ICU 78.2, and Unicode 17.0 values.
- Exact `/private/tmp/fyi-host-runtime-gap-104.paths` sample under Node 25.9.0
  (V8 14.1, ICU 78.2, Unicode 17.0) — **104/104 passed** in the GC host lane;
  validation artifact: `/private/tmp/fyi-host-runtime-gap-node25.json`.
