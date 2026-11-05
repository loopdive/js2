---
id: 7241
title: "IR class shapes: classes that extend a lib interface (`extends Iterator`) and array-returning members get no shape"
status: ready
sprint: current
created: 2026-11-05
updated: 2026-11-05
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [7233, 7227, 7223, 2917]
assignee: "ttraenkler/c-lead"
# 2026-11-05 (#7241): the selector admission arm for a flat lib-interface
# shape lives beside the gate it relaxes; the any[] return arm beside the
# class-position projection it extends (resolveWasmType is in index.ts).
loc-budget-allow:
  - src/ir/select-identity.ts
  - src/codegen/index.ts
func-budget-allow:
  - src/ir/select-identity.ts::planIrCompilationByIdentity
  - src/codegen/index.ts::buildIrClassShapes
---

# #7241: two class buckets that are cheap in legacy ABI terms

## Problem

Every one of the 218 `select:class-member-unsupported` units on the stride-40
standalone ledger (origin/main `7b08173add`) has been attributed. The two
largest buckets outside other lanes' scope are below. Out-of-scope lanes are
async/generator, accessors (the Shepherd's getter-callable repair), the
move-only scan, and default/destructured params.

1. **`class X extends Iterator`**: 7 stride units in 4 files. 207 test262
   files contain the pattern; that file count is measured, the ~200–280 units
   it implies are extrapolated.
   - `buildIrClassShapes` (`src/codegen/index.ts` ~L1804) drops the class.
     `resolveIrParentClassId` (`src/codegen/ir-class-shapes.ts` ~L176) returns
     `undefined` because the lib declares `Iterator` as an interface ("Cannot
     extend an interface"), so no shape is built and the selector's descriptor
     lookup misses (`src/ir/select-identity.ts` ~L1350).
   - Legacy lays these classes out as ordinary root structs with
     self-receiver slots: `$TestIterator_new`,
     `$TestIterator_next (param (ref null N))`. `Iterator` is not in
     `classBuiltinParentMap` or `classExternrefBackedSet`.
2. **Array-returning members of the compiler's injected `Intl.ListFormat`
   polyfill** (`__js2wasm_Intl_ListFormat`): 4 stride units, 2 in each of the
   ~81 `intl402/ListFormat` files.
   - `formatToParts()` and `static supportedLocalesOf()` return arrays, and
     `tsTypeToClassPositionIr` has no class-position IR type for an array, so
     the members get no descriptor.

## Implementation Plan (C lead, 2026-11-05; implement on Opus)

1. **Measure and confirm first.**
   - Reproduce both buckets on your base: the stride ledger plus a targeted
     sample of all 207 `extends Iterator` files and all `intl402/ListFormat`
     files, standalone.
   - Record the IR units in that targeted sample before you change anything.
     This sample, not the stride, is the main A/B for this issue.
2. **`extends <lib interface>` as a flat root shape.** In `buildIrClassShapes`,
   project the class as a root shape with no `.parent`, the same way an
   `implements`-only class is projected. Do this ONLY when legacy also lays
   it out as a root struct:
   - the heritage expression does not resolve to a local class;
   - it is not in `classBuiltinParentMap`;
   - it is not in `classExternrefBackedSet`;
   - it is not host-constructible (`BUILTIN_PARENTS_HOST_CONSTRUCTIBLE`).

   Assert this against the legacy layout decision, using the same predicate
   legacy uses. Don't re-derive it. Then relax the selector gate in
   `select-identity.ts` (~L1360, `hasParent && !claimableUnderParent`) for
   exactly that case.
   - Keep the implicit or explicit derived constructor (`super()` into
     `Iterator`) on legacy.
   - `get next` accessors stay with the accessor lane.
   - Methods use the existing self-receiver slot ABI, behind the #1370
     parity guard.
3. **Array-returning members.**
   - Find what legacy's slot type is for a method returning `T[]`:
     `$Vec_*` ref, externref, or something else.
   - If that slot type is already an IR-representable type, add the matching
     class-position mapping in `tsTypeToClassPositionIr`, restricted to the
     exact legacy slot type.
   - If it isn't, stop and report; don't add a new array ABI.
   - The polyfill is compiler-injected source. Check that its units count as
     test units in the ledger's attribution, and say so either way.
4. **Do not touch:**
   - async/generator members;
   - `dynamicUsesAreMoveOnly`;
   - the Shepherd's getter-callable files: `class-bodies.ts`,
     `closures/method-trampolines.ts`,
     `program-abi-class-callable-planning.ts`, `method-receiver-this.ts`,
     `property-access-exact-shapes.ts`. You may read them.
5. **Never worse than legacy.** On gc, standalone and wasi, probe:
   - iterator protocol use: `for…of`, spread, `Array.from`;
   - `Iterator.prototype` helpers on the subclass: `reduce`, `some`, `map`,
     `take`;
   - `instanceof Iterator`;
   - `return()` and `throw()` closing;
   - exceptions thrown from `next`;
   - subclass of a subclass;
   - methods called as values and via `.call`.

   For ListFormat: `formatToParts` results used as arrays (`length`, index,
   `map`, `JSON.stringify`) and `supportedLocalesOf` identity.

## Acceptance criteria

- **Targeted sample A/B** (the 207 `extends Iterator` files plus the
  `intl402/ListFormat` files, standalone; IR units rise; 0 lost) and stride
  ledger A/B in the PR body, with 0 invariants and `compileOk` not lower.
- **Typed corpus** byte-identical on gc, standalone and wasi, or every changed
  binary explained.
- **test262 A/B** on the targeted sample, standalone: no test that passes on
  base fails on head.
- **Test:** `tests/equivalence/issue-7241-ir-class-lib-interface-parent.test.ts`.
  For each bucket it asserts the IR route (`trackIrOutcomes`), the
  stays-legacy routes (constructor, `get next`), and the node/base result on
  3 lanes.
