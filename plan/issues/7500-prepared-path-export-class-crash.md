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
related: [7488, 7508, 7354]
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

### Decision: refuse at select — one generic export rule plus the class-modifier case (lead's option (b))

Two crash shapes, two conditions, one module (`src/ir/prepared-select-refusals.ts`), both refused before any body is
lowered:

1. **An unresolved local export (generic).** A local `export { … }` clause (no module specifier) whose local name has
   no planned local target: not a top-level `var`/`let`/`const` identifier and not a function declaration with a unit.
   This is exactly the condition under which `buildIrModuleInitPlan` records an `unresolved-export-target` gap, which
   today reaches the final validation and throws. It covers classes (`class C {} export { C }`, `{ C as D }`,
   `{ C as default }`, before the declaration, `class C {} { let C = 1; } export { C }`) and PRV-7500's six non-class
   shapes: an import binding (`import { a } …`, `import * as m …`, `import x = require(…)`), a type (`type T`), an
   ambient `declare function`, and an undeclared name (`export { zz }`), filed as
  [#7508](7508-prepared-path-unresolved-local-export-crash.md) and closed by this rule. New `IrUnsupportedCode`
   `export-target-unsupported`, stage `select`, detail "export X has no local binding the Prepared path plans".
2. **An exported class declaration (modifier).** `export class C {}`, `export default class D {}`,
   `export abstract class C {}`: `buildIrModuleInitPlan` records an alias to the callable binding of the class's
   constructor unit, which no Prepared producer plans (crash in physical planning). Added to #7488's top-level class
   loop next to "its definition runs code", with the same owner (the constructor unit). Code
   `class-export-unsupported`.

**Shared helpers, no second copy of the export logic.** Two exported functions move out of `buildIrModuleInitPlan`
into `src/ir/module-init-plan.ts` next to it:
- `localExportTargets(sourceFile, sourceId, identityContext)`: today's up-front `targetBindingByName` map (the "has a
  target" rule).
- `localExportSpecifiers(statement)`: today's inline walk of a local `export { … }` clause, its specifiers with their
  local names; `undefined` for any other statement.
`buildIrModuleInitPlan` calls both (same entries, same order: the plan is unchanged). Rule 1 calls both, so "unresolved"
means exactly what the plan's gap means and the two cannot drift.

**Owner of a refusal that has no unit (small contract extension).** Rule 1's programs can have no unit at all (an
import plus an export clause). `PreparedIrProgramFailure.unitId` becomes `IrUnitId | null`, and `owner.ts` gains
`sourceOwner(inventory, sourceFile, node)`: the source's key and the node's line/column/span, with `unitId: null`. It
feeds the existing `failureAt`. `PreparedIrProgramOwner`, `preparedIrProgramOwner`, `locatedFailure` and their guards
are unchanged; only the failure type widens. Measured: widening the type alone typechecks with no consumer change
(the test262 entry reads `code`, `detail`, `sourceFile`, `location.line/column`, never `unitId`).

**Precedence.** These rules run before the producer's other refusals, so exported classes that were refused for
another reason report the new code instead: `export class C { constructor() {} }`, `export class C { x = 1 }` →
`class-export-unsupported`; `class C { static m() {} } export { C }` → `export-target-unsupported`.
`export class C extends Object {}` keeps #7488's `class-definition-evaluation` (checked first). Accepted and pinned.

**Cost (estimate, to be confirmed in the PR):** about 45 lines net: contract 1, `owner.ts` about 15, helper extraction
about 10 net, rules about 20. No owner guard touched.

Ordinary pipeline: `buildIrModuleInitPlan` is shared, so the helper extraction must keep ordinary bytes identical
(checked on a sample, default and standalone).

### Acceptance

- Correctness: every shape above is refused by name under both `unlowerableBodies` policies, and `compile()` returns
  rather than throws: PRV-7500's 13 class shapes and 6 non-class shapes. Pins assert a named refusal and no throw, not
  a specific error class (`compile()` wraps the invariant as `PreparedValidatorError`).
- Unchanged: `export default class {}`, `class C {} export default C;`, `function f() {} export { f as g }`,
  `var v = 1; export { v }`, `export declare class C {}` (.ts), `export * from`, `export { a } from`.
  `export class C extends Object {}` keeps `class-definition-evaluation`.
- Code quality: the export walk and the target rule exist once (moved, not copied); both rules sit in the one
  select-refusal module; the failure contract widens by one nullable field, no guard weakened; `program-source.ts`
  unchanged.
- Ordinary pipeline byte-identical on a 100-file sample × (default, standalone).

### Yield (measured)

None on test262: the 163 test262 files with a top-level `export class` / `export {` / `export default class` give
compile_error 134 and skip 29 on `f0de1a53` (`prepared-census --harness real`), with no crash. These forms are masked
by earlier refusals there (script-goal `export` errors, harness bindings). This issue is soundness (a thrown invariant
out of `compile()`), not yield.

### Note

`export default class {}` creates no export intent, so its default export is silently absent. Not observable in a
single-file program, and not a crash; noted for the multi-module work.
