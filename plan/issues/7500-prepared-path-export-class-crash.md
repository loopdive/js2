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

### Decision: refuse at select, in the #7488 class rule; non-class exports to a follow-up

- **Module:** `src/ir/prepared-select-refusals.ts`. Its top-level class loop (#7488) gains a second condition next to
  "its definition runs code": the class is **exported by name**, either with an `export` modifier (`export class C`,
  `export default class D`, `export abstract class C`) or named as the local of a local `export { … }` clause (no
  module specifier) in the same file. These are exactly the two places where `buildIrModuleInitPlan` creates an
  export intent for a class. New `IrUnsupportedCode` `class-export-unsupported`, stage `select`, detail "class C is
  exported, and the Prepared path has no class value to export". Located at the class's constructor unit, like
  #7488's refusal.
- **One clause walk, shared.** `buildIrModuleInitPlan` (`src/ir/module-init-plan.ts`) walks local `export { … }`
  clauses inline. That walk moves into one exported helper next to it, `localExportSpecifiers(statement)`: for a
  local export clause, its specifiers with their local names; otherwise `undefined`. `buildIrModuleInitPlan` and the
  class rule both call it, so the two cannot drift. The plan's behaviour is unchanged (same specifiers, same order).
- **Reuses:** the #7488 loop, its `declare` skip, its owner (`failureAt(unitOwner(...))`).
- **Precedence.** The class rule runs first, so classes that were refused for another reason report the new code
  instead: `export class C { constructor() {} }`, `class C { static m() {} } export { C }`, `export class C { x = 1 }`
  (were `type-resolution-unsupported`, "no body producer"), and `export class C extends Object {}` keeps #7488's
  `class-definition-evaluation` (that condition is checked first). Accepted and pinned.
- **Not in this issue: non-class export targets.** PRV-7500 found six programs that still throw "retains unresolved
  binding/export gaps" with this change: a local `export { x }` whose `x` is an import binding (`import { a } …`,
  `import * as m …`, `import x = require(…)`), a type (`type T`), an ambient `declare function`, or undeclared
  (`export { zz }`, a module early error). Their gap is the same `unresolved-export-target`, but their inventory has
  no unit at all, so a refusal has no owner: it needs a source-level owner or a change to `PreparedIrProgramFailure`.
  That decision is filed as its own issue with the six repros (id requested from the lead); the shared helper above is
  what its rule will use. (The plan's earlier claim that "the other gap kinds are already refused earlier" holds only
  for `destructuring-binding-abi`, and is corrected here.)
- Ordinary pipeline: `buildIrModuleInitPlan` is shared, so the helper extraction must keep ordinary bytes identical
  (checked on a sample, default and standalone).

### Acceptance

- Correctness: the 13 class shapes PRV-7500 probed are refused by name (`class-export-unsupported`) under both
  `unlowerableBodies` policies, and `compile()` returns rather than throws: `export class C {}`,
  `export default class D {}`, `export abstract class C {}` (.ts), `class C {} export { C }`, `export { C as D }`,
  `export { C as default }`, `export { C }` before the declaration, a class exported twice,
  `export class C {} export { C as D }`, `class C {} { let C = 1; } export { C }`, and the three precedence cases above.
  Unchanged: `export default class {}`, `class C {} export default C;`, a function export, `export declare class C {}`
  (.ts), `export * from`, `export { a } from`. `export class C extends Object {}` keeps `class-definition-evaluation`.
- Pins assert a named refusal and no throw, not a specific error class (`compile()` wraps the invariant as
  `PreparedValidatorError`).
- Code quality: one clause walk (moved, not copied); the new condition is one predicate next to `runsCode` in the
  same loop; `program-source.ts` unchanged.
- Ordinary pipeline byte-identical on a 100-file sample × (default, standalone).

### Yield (measured)

None on test262: the 163 test262 files with a top-level `export class` / `export {` / `export default class` give
compile_error 134 and skip 29 on `f0de1a53` (`prepared-census --harness real`), with no crash. These forms are masked
by earlier refusals there (script-goal `export` errors, harness bindings). This issue is soundness (a thrown invariant
out of `compile()`), not yield.

### Note

`export default class {}` creates no export intent, so its default export is silently absent. Not observable in a
single-file program, and not a crash; noted for the multi-module work.
