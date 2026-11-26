---
id: 7500
title: "Prepared path crashes on `export class C {}`: alias targets unplanned binding"
status: in-progress
sprint: current
created: 2026-11-26
updated: 2026-11-26
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
goal: backend-agnostic-ir
related: [7488, 7354]
---

# Prepared path crashes on `export class C {}`

## Problem

On the Prepared whole-program path (`wholeProgram: {kind: "prepared-program-required", version: 1}`), an exported
class declaration without heritage makes `compile()` throw instead of returning a result:

```
ProgramAbiInvariantError: alias ir-binding:v1:export:ir-source%3Av1%3A…%3Aentry%3Atest.js:C:… targets unplanned
binding ir-binding:v1:callable:ir-unit%3Av1%…
```

The path's rule is JavaScript's answer or a named refusal. An invariant thrown out of `compile()` is neither: it is a
crash. Found by the plan review of #7488 (PRV-7488), 2026-11-26.

## Repro (PR 7440 head `3d70c9c8`, main `c3b7be66` + #7446; standalone, `fileName: "test.js"`)

| Program | Prepared |
| --- | --- |
| `export class C {}` | **crash** (ProgramAbiInvariantError, above) |
| `export class C {} var n = 1;` | **crash** (same) |

(Under a Module goal the program is valid; a Script goal rejects `export`. Either way the answer is a result, not a
thrown invariant.)

## Acceptance criteria

- `export class C {}` either compiles with JavaScript's semantics or is refused by name at compile time (select
  stage); `compile()` never throws an invariant for it.
- Pin tests for the plain exported class, with and without other top-level code.
- The ordinary pipeline's output is unchanged.

## Notes

- The export alias points at the class's callable binding, which the Prepared producer never plans because it has no
  body producer for the class (its constructor is a root `class-implicit-constructor` support unit). Look first at
  where export aliases are planned against callable units in the Prepared ABI planning, and refuse there when the
  target has no producer.

## Implementation Plan

Written 2026-11-26, stacked on PR 7458 (#7488, head `f0de1a53`), which this change extends.

### Where it crashes (measured on `f0de1a53`)

| Program | Prepared |
| --- | --- |
| `export class C {}` | crash: `ProgramAbiInvariantError` "alias … targets unplanned binding" (physical planning) |
| `export default class D {}` | crash: same |
| `class C {} export { C };`, `class C {} export { C as D };` | crash: `PreparedIrProgramInvariantError` "startup source … retains unresolved binding/export gaps" (validation) |
| `export class C { constructor() {} }`, `class C { static m() {} } export { C };` | refused (no body producer for the member); the class has a terminal unit that refuses first |
| `export default class {}`, `class C {} export default C;`, `function f() {} export { f as g };` | compile |

Cause: `buildIrModuleInitPlan` records an export of a class either as an alias to the callable binding of the class's
constructor unit (`export class`), or as an `unresolved-export-target` gap (`export { C }`: classes are not module
bindings). When that constructor is a root support unit (implicit constructor, no instance initializers), nothing the
Prepared producer builds plans that binding, so the alias reaches physical planning unplanned, and the gap reaches
the final validation, which throws. The path has no class value at all (a reference to `C` refuses "not in scope"), so
exporting one cannot work.

### Decision: refuse at select, in the #7488 class rule

- **Module:** `src/ir/prepared-select-refusals.ts`. Its top-level class loop (#7488) gains a second condition next to
  "its definition runs code": the class is **exported by name**, either with an `export` modifier (`export class C`,
  `export default class D`) or named as the local of an `export { … }` clause without a module specifier in the same
  file. These are exactly the two places where `buildIrModuleInitPlan` creates an export intent for a class.
  New `IrUnsupportedCode` `class-export-unsupported`, stage `select`, detail "class C is exported, and the Prepared
  path has no class value to export". Located at the class's constructor unit, like #7488's refusal.
- **Reuses:** the #7488 loop, its `declare` skip, its owner (`failureAt(unitOwner(...))`). No new module, no change
  to `buildIrModuleInitPlan` or to validation.
- **Why not refuse on the startup plan's gaps instead:** a gap has a source range but no unit to own it (here the file
  has no terminal unit), and the `export class` crash is not a gap at all. The class rule covers both shapes with one
  owner. A general "startup gap → refusal" is not needed for this issue: the other gap kinds (`destructuring-binding-abi`)
  are already refused earlier (probed: `var [a] = [1]`, `export var [c] = [1]`).
- Ordinary pipeline: untouched (Prepared producer only).

### Acceptance

- Correctness: the four crashing programs above are refused by name (`class-export-unsupported`) under both
  `unlowerableBodies` policies; `compile()` never throws for them. The compiling ones stay unchanged
  (`export default class {}`, `class C {} export default C;`, a function export). An exported class whose definition
  runs code (`export class C extends Object {}`) keeps #7488's `class-definition-evaluation`.
- Pin tests fail (throw) on the PR 7458 head and pass after.
- Code quality: the new condition is one predicate next to `runsCode` in the same loop; no duplication of the
  module-init plan's export logic beyond the two syntactic shapes it keys on; `program-source.ts` unchanged.

### Yield (measured)

None on test262: the 163 test262 files with a top-level `export class` / `export {` / `export default class` give
compile_error 134 and skip 29 on `f0de1a53` (`prepared-census --harness real`), with no crash. These forms are masked
by earlier refusals there (script-goal `export` errors, harness bindings). This issue is soundness (a thrown invariant
out of `compile()`), not yield.
