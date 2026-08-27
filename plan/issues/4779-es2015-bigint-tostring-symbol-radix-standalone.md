---
id: 4779
title: "ES2015 standalone BigInt.prototype.toString rejects Symbol radix"
status: in-progress
sprint: current
created: 2026-08-27
updated: 2026-08-27
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: conformance
area: codegen
language_feature: BigInt.prototype.toString
es_edition: es6
goal: standalone-mode
related: [1644, 1564]
loc-budget-allow:
  - src/codegen/expressions/call-receiver-method.ts
func-budget-allow:
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
assignee: "ttraenkler/es6-next-bounded-fix-4"
files:
  - src/codegen/expressions/call-receiver-method.ts
  - src/codegen/js-errors.ts
  - tests/issue-4779-bigint-tostring-symbol-radix.test.ts
  - plan/issues/4779-es2015-bigint-tostring-symbol-radix-standalone.md
---

# #4779 — ES2015 standalone `BigInt.prototype.toString` rejects Symbol radix

## Problem

The maintained ES2015 Test262 row
`built-ins/BigInt/prototype/toString/radix-tointegerorinfinity-throws-symbol.js`
passes in host mode but fails under `--target standalone`. The standalone
BigInt `toString` lowering currently sends a statically-created `Symbol` radix
through its numeric (`f64`) conversion path instead of applying the specified
`ToNumber` abrupt completion. The resulting failure is reported as
`Thrown value was not an object!`, rather than as a catchable `TypeError`.

This issue owns exactly that one standalone residual. It does not reopen the
completed BigInt formatting work in #1644, change host BigInt behavior, or
bundle adjacent invalid-radix and receiver cohorts without solo evidence.

## Exact cohort and baseline (2026-08-27)

The cohort is exactly one maintained ES2015 row:

- `test/built-ins/BigInt/prototype/toString/radix-tointegerorinfinity-throws-symbol.js`

The row was run alone through `tests/test262-runner.ts` using an absolute
`test262/test/...` path from upstream/main commit
`6e3fdf2166a33d76260791b8df0bb4bf5f503324`, with the Test262 submodule at
`b363f29d3c43c626dc852744ad64a0b48a003693`. The accurate baseline is:

- host: **1/1 pass, 0 fail, 0 compile errors, 0 timeouts, 0 skips**
- standalone: **0/1 pass, 1 fail, 0 compile errors, 0 timeouts, 0 skips**

Standalone compilation succeeds with no host imports; only execution fails.
The observed standalone assertion is `Test262Error: If _radix_ is Symbol,
BigInt.prototype.toString must throw a TypeError Thrown value was not an
object! | at L22: assert.throws(TypeError...)`.

## Implementation plan

1. Add a narrow static `Symbol`/unsupported numeric radix guard in the
   standalone BigInt `toString` method lowering. Evaluate the radix expression
   and emit the shared native standalone TypeError object on the abrupt path,
   preserving the existing ordinary numeric radix conversion and formatting.
2. Keep host BigInt lowering, receiver checks, string formatting, and unrelated
   call dispatch unchanged. Do not add imports, harness exemptions, skips, or
   fixture rewrites.
3. Add a focused regression that runs this exact row in host and standalone
   modes and controls ordinary numeric radix formatting and invalid-radix
   TypeError behavior.
4. Rerun the exact one-row A/B cohort with at most two workers, focused tests,
   and mandatory type/lint/format checks. Record artifacts, residuals, commit,
   and PR handoff here.

## Acceptance criteria

- The exact row passes in both host and standalone modes.
- Standalone reports no compile errors, compile timeouts, skips, or host
  imports for the row.
- A statically-created Symbol radix throws a catchable `TypeError` in
  standalone mode, while ordinary numeric radix values retain existing native
  formatting.
- Host behavior and unrelated BigInt prototype rows do not regress.
- The dedicated upstream PR follows the repository Description/CLA template,
  stays draft with `hold` until current-main verification and green CI prove it
  mergeable, and keeps `mergeQueueEntry: null` before readiness.

## Evidence and handoff before implementation

The failure is localized to the non-host BigInt `toString` radix branch in
`src/codegen/expressions/call-receiver-method.ts`, which compiles the first
argument as `f64`, floors it, range-checks it, and calls the native radix
formatter. The existing `emitSymbolArgToNumberThrow`/`emitThrowTypeError`
helpers provide the intended catchable standalone error representation. The
standalone native formatter itself remains a pure `(i64, i32) -> externref`
operation and should not be changed for this one argument-conversion defect.
