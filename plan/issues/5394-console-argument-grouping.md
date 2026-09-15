---
id: 5394
title: "Preserve console call argument grouping in the JavaScript host target"
status: in-progress
sprint: current
created: 2026-09-08
updated: 2026-09-08
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: runtime
goal: correctness
parent: 5393
assignee: "ttraenkler/codex-console-soundness"
func-budget-allow:
  - src/compiler/import-manifest.ts::classifyImport
loc-budget-allow:
  - src/codegen/expressions/builtins.ts
# 2026-09-08: add one console-group dispatch and classify its existing console capability intent.
---

## Measured defect

The new general-JavaScript audit's observation controls compare identical
Node console formatting callbacks. For `console.log("value", 3, false)`, Node
and standalone print `value 3 false\n`, but the host target calls the observer
three times and prints `value\n3\nfalse\n`. Source inspection points to the
per-argument host loop in `compileConsoleCall`.

This is an observable console behavior defect; do not normalize line breaks
away in the differential audit. Preserve grouping, evaluation order, and
single-argument calls. Record any unsupported format/object cases separately.

## Acceptance criteria

- [x] Confirm the exact reproduction and a single-argument control.
- [x] Preserve one console call's arguments and Node output order.
- [x] Preserve effects of argument evaluation and nested console calls.
- [x] Check host, optimized host, and existing standalone controls.
- [x] Run affected console/equivalence tests without broadening baselines.

## Implementation

Grouped host calls evaluate all arguments left to right onto the Wasm stack,
then invoke one typed import using the existing console capability intent.
No shared accumulator is used: nested console calls remain independent and a
throwing argument prevents the outer call. Zero arguments also invoke console
once. The runtime preserves boolean brands and forwards the complete argument
list to the host formatter, retaining Node printf substitutions.

Unexpanded console spread arguments now report a compile error (#5394); this
change does not implement iterator expansion. Existing standalone and WASI
console paths are unchanged.

## Validation

The focused regression checks cover zero/one/multiple arguments, all five
console methods, legacy and IR lowering, optimization, nested calls,
once-only argument effects, abrupt argument completion, printf substitutions,
nullish values, negative zero, NaN, bigint, standalone output, and explicit
spread refusal. They compare exact argument arrays with Node VM execution.

The nine focused tests and 21 adjacent console/equivalence tests pass. The
earlier CLI invocation supplying a string instead of an execArgv array never
executed tests and is unmeasured; validation uses an actual-array scratch
Vitest config including the Node Wasm exception-reference flag.

Integration must refresh the platform adapter's source digest in the existing
dynamic-import preservation witness; the dynamic import implementation is
unchanged. No audit output normalization or shared baseline is broadened.
